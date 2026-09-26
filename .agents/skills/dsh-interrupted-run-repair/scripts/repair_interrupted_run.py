#!/usr/bin/env python3
"""Detect, repair, and re-verify the on-disk residue of an interrupted run.

A killed or crashed writer leaves residue that a plain re-run does not clear:
a line truncated mid-write, a JSON file rewritten by a `truncate` + `write`
pair, a zero-byte completion marker that existence-only readers accept, or a
lock file whose holder is dead. Some of that residue makes the re-run *fail
again deterministically*; some of it is accepted silently as success.

This tool works from a **run contract** — the artifact list a run claims to
produce — so it never guesses which files matter:

    {
      "run": "orderbook-close-2026-09-25",
      "artifacts": [
        {"path": "state/day_2026-09-25.jsonl", "kind": "jsonl",
         "unique_key": ["code", "at"]},
        {"path": "panel/prices/SH600104.csv", "kind": "csv", "columns": 4},
        {"path": "panel/manifest.json", "kind": "json"},
        {"path": "state/closed_2026-09-25", "kind": "json",
         "role": "completion-marker"},
        {"path": "state/close.lock", "kind": "lock", "lease_seconds": 43200}
      ]
    }

Findings carry one of three kinds. **corruption** is residue that blocks or
falsifies a re-run. **incompleteness** is an absent artifact or an unmarked
completion, which only re-running the producer can fix. **advisory** is
reported for operator judgement and never fails a run.

Repair is tiered, and every tier is idempotent and discloses what it touched:

* tier 1 (default) — truncate a partial tail, quarantine a wholly unparseable
  file, clear a lock whose holder is provably dead or whose content is
  unreadable.
* tier 2 (`--quarantine-lines`) — copy the file aside, then keep only the
  parseable lines, because dropping records is a semantic decision.
* tier 3 (`--dedup`) — keep the first record per declared `unique_key`, because
  a re-run appends records it could not see behind a corrupt line.

Nothing here invents content, rewrites a record's meaning, or deletes without
archiving. A lock whose holder is alive is never cleared, not even past its
lease, unless the operator passes `--force-live-lock`.

Exit codes: 0 clean, 1 residue or an incomplete run remains, 2 usage or contract
error (including an artifact path escaping the root).

The `selftest` subcommand builds every residue case in a temporary directory and
asserts the full loop for each one — detect, repair, re-run, verify — plus the
negative controls that must stay untouched.
"""

from __future__ import annotations

import argparse
import contextlib
import csv
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

CORRUPTION = "corruption"
INCOMPLETENESS = "incompleteness"
ADVISORY = "advisory"

SUPPORTED_KINDS = ("jsonl", "csv", "json", "lock", "text")


# --------------------------------------------------------------------------
# Process liveness (portable)
# --------------------------------------------------------------------------


def pid_alive(pid: int) -> bool:
    """Report whether a process id is currently running.

    A pid that is not running, or a pid this process may not query, decides the
    caller's lock policy; both callers treat "unknown" as alive so a lock is
    never cleared on a failed liveness probe.

    @param pid - Process id recorded by the lock holder.
    @returns True when the process is still running.
    """
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes

        process_query_limited_information = 0x1000
        still_active = 259
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
            return code.value == still_active
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


# --------------------------------------------------------------------------
# Report model
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Finding:
    """One defect observed in a declared artifact.

    @param code - Stable identifier callers assert on, e.g. `BAD_JSONL_LINE`.
    @param rel - Artifact path relative to the contract root.
    @param kind - `corruption`, `incompleteness`, or `advisory`.
    @param detail - Human-readable specifics, including counts and line numbers.
    @param line - 1-based line number when the finding is line-scoped.
    @param repairable - Repair code that clears it, or None when only a producer
        re-run can.
    """

    code: str
    rel: str
    kind: str
    detail: str
    line: int | None = None
    repairable: str | None = None


@dataclass
class Action:
    """One repair outcome, in one of three states.

    @param code - Repair identifier, e.g. `TRUNCATE_PARTIAL_TAIL`.
    @param rel - Artifact path relative to the contract root.
    @param detail - What changed, with byte or line counts.
    @param archive - Path of the archived evidence, or None when none was kept.
    @param applied - True only when this run changed the artifact.
    @param planned - True for a `--dry-run` plan, which changed nothing.
    """

    code: str
    rel: str
    detail: str
    archive: str | None = None
    applied: bool = True
    planned: bool = False

    @property
    def state(self) -> str:
        """Return `applied`, `planned`, or `deferred`."""
        if self.applied:
            return "applied"
        return "planned" if self.planned else "deferred"


@dataclass
class Artifact:
    """A file a run claims to produce, as declared by the contract.

    @param path - Absolute path inside the contract root.
    @param rel - Path as declared, normalized to forward slashes.
    @param kind - One of `SUPPORTED_KINDS`.
    @param unique_key - Record fields that must not repeat, for `jsonl`.
    @param columns - Expected CSV field count; defaults to the header length.
    @param role - `completion-marker` marks the run as finished by existing.
    @param required - A missing artifact is `incompleteness` rather than silent.
    @param lease_seconds - Lock age past which a live holder is reported.
    """

    path: Path
    rel: str
    kind: str
    unique_key: tuple[str, ...] = ()
    columns: int | None = None
    role: str | None = None
    required: bool = False
    lease_seconds: float = 12 * 3600.0


@dataclass
class Contract:
    """Parsed run contract.

    @param run - Operator-supplied run label, echoed into every report.
    @param root - Directory that all artifact paths are resolved against.
    @param artifacts - Declared artifacts, in contract order.
    @param unmatched_globs - Required patterns that matched nothing, so a
        daily chain's missing output is reported instead of passing silently.
    """

    run: str
    root: Path
    artifacts: list[Artifact] = field(default_factory=list)
    unmatched_globs: list[str] = field(default_factory=list)


class ContractError(Exception):
    """Raised when the contract cannot be trusted to name files safely."""


def load_contract(contract_path: Path, root_override: Path | None) -> Contract:
    """Read and validate a run contract.

    Every artifact path must stay inside the root: an interrupted repair must
    never be able to reach outside the run's own tree.

    @param contract_path - Path to the JSON contract.
    @param root_override - Root directory overriding the contract file's parent.
    @returns The validated contract.
    @raises ContractError - On unreadable JSON, unknown kind, or path escape.
    """
    try:
        raw = json.loads(contract_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ContractError(f"contract unreadable: {error}") from None
    if not isinstance(raw, dict):
        raise ContractError("contract must be a JSON object")
    root = (root_override or contract_path.parent).resolve()
    entries = raw.get("artifacts")
    if not isinstance(entries, list) or not entries:
        raise ContractError("contract needs a non-empty artifacts array")
    artifacts: list[Artifact] = []
    unmatched: list[str] = []
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise ContractError(f"artifacts[{index}] must be a JSON object")
        pattern = entry.get("glob")
        single = entry.get("path")
        if pattern is not None and not isinstance(pattern, str):
            raise ContractError(f"artifacts[{index}] glob must be a string")
        if single is not None and not isinstance(single, str):
            raise ContractError(f"artifacts[{index}] path must be a string")
        if (pattern is None) == (single is None):
            raise ContractError(f"artifacts[{index}] needs exactly one of path or glob")
        kind = entry.get("kind", "text")
        if kind not in SUPPORTED_KINDS:
            raise ContractError(
                f"artifacts[{index}] kind must be one of {SUPPORTED_KINDS}, got {kind!r}")
        unique_key = entry.get("unique_key", [])
        if not isinstance(unique_key, list) or not all(isinstance(k, str) for k in unique_key):
            raise ContractError(f"artifacts[{index}] unique_key must be a string array")
        columns = entry.get("columns")
        if columns is not None and (not isinstance(columns, int) or columns <= 0):
            raise ContractError(f"artifacts[{index}] columns must be a positive integer")
        if pattern is not None:
            normalised = pattern.replace("\\", "/")
            declared_paths = [candidate.relative_to(root).as_posix()
                              for candidate in sorted(root.glob(normalised))
                              if candidate.is_file() and candidate.resolve().is_relative_to(root)]
            if not declared_paths:
                if entry.get("required"):
                    unmatched.append(normalised)
                continue
        else:
            declared_paths = [single.replace("\\", "/")]
        for declared in declared_paths:
            resolved = (root / declared).resolve()
            if not resolved.is_relative_to(root):
                raise ContractError(f"artifacts[{index}] escapes the root: {declared}")
            artifacts.append(Artifact(
                path=resolved,
                rel=declared,
                kind=kind,
                unique_key=tuple(unique_key),
                columns=columns,
                role=entry.get("role"),
                required=bool(entry.get("required", False)),
                lease_seconds=float(entry.get("lease_seconds", 12 * 3600)),
            ))
    return Contract(run=str(raw.get("run", contract_path.stem)), root=root,
                    artifacts=artifacts, unmatched_globs=unmatched)


# --------------------------------------------------------------------------
# Detection
# --------------------------------------------------------------------------


def _decode(data: bytes, rel: str) -> tuple[str | None, list[Finding]]:
    """Decode artifact bytes, reporting a truncated multi-byte tail as corruption."""
    try:
        return data.decode("utf-8"), []
    except UnicodeDecodeError as error:
        return None, [Finding(
            code="UNDECODABLE_BYTES",
            rel=rel,
            kind=CORRUPTION,
            detail=(f"utf-8 decode failed at byte {error.start} of {len(data)}"
                    f" (interrupted multi-byte write)"),
            repairable="QUARANTINE_FILE",
        )]


def _tail_record_complete(artifact: Artifact, tail: bytes) -> bool:
    """Report whether a newline-less final chunk holds a whole record.

    A complete record that only lost its newline is terminated in place, which
    keeps every byte; an incomplete one is already lost and is truncated
    instead. `text` has no record grammar, so its tail is always kept.

    @param artifact - Declared artifact the tail belongs to.
    @param tail - Final bytes after the last newline.
    @returns True when the tail is keepable as a record.
    """
    if artifact.kind == "text":
        return True
    text = tail.decode("utf-8", errors="replace")
    if artifact.kind == "jsonl":
        try:
            json.loads(text)
        except ValueError:
            return False
        return True
    rows = [row for row in csv.reader(io.StringIO(text)) if row]
    if not rows:
        return False
    expected = artifact.columns or len(rows[0])
    return all(len(row) == expected for row in rows)


def detect_artifact(artifact: Artifact, *, verifying: bool) -> list[Finding]:
    """Inspect one artifact.

    @param artifact - Declared artifact to inspect.
    @param verifying - True for `verify`, which also fails incomplete runs.
    @returns Findings in a stable order; empty means the artifact is intact.
    """
    findings: list[Finding] = []
    if not artifact.path.exists():
        if artifact.required or (artifact.role == "completion-marker" and verifying):
            findings.append(Finding(
                code="MISSING_ARTIFACT",
                rel=artifact.rel,
                kind=INCOMPLETENESS,
                detail="declared artifact is absent; the producing run must be re-run",
            ))
        return findings

    data = artifact.path.read_bytes()
    if not data:
        if artifact.role == "completion-marker":
            findings.append(Finding(
                code="EMPTY_MARKER",
                rel=artifact.rel,
                kind=CORRUPTION,
                detail=("completion marker exists but is empty; readers that test"
                        " existence alone treat the run as finished"),
                repairable="QUARANTINE_FILE",
            ))
        elif artifact.kind in ("json", "csv"):
            findings.append(Finding(
                code="EMPTY_FILE",
                rel=artifact.rel,
                kind=CORRUPTION,
                detail="declared artifact is empty",
                repairable="QUARANTINE_FILE",
            ))
        elif artifact.kind == "jsonl" and artifact.required:
            findings.append(Finding(
                code="EMPTY_FILE",
                rel=artifact.rel,
                kind=INCOMPLETENESS,
                detail="declared jsonl artifact has no records",
            ))
        return findings

    if artifact.kind in ("jsonl", "csv", "text") and not data.endswith(b"\n"):
        tail = data[data.rfind(b"\n") + 1:]
        if _tail_record_complete(artifact, tail):
            findings.append(Finding(
                code="MISSING_FINAL_NEWLINE",
                rel=artifact.rel,
                kind=CORRUPTION,
                detail=(f"the final {len(tail)}-byte record is complete but has no"
                        " terminating newline; the next append would concatenate onto it"),
                repairable="APPEND_FINAL_NEWLINE",
            ))
        else:
            findings.append(Finding(
                code="PARTIAL_LAST_LINE",
                rel=artifact.rel,
                kind=CORRUPTION,
                detail=(f"file does not end with a newline and its final"
                        f" {len(tail)}-byte tail is not a whole record;"
                        " the write was interrupted"),
                repairable="TRUNCATE_PARTIAL_TAIL",
            ))

    text, decode_findings = _decode(data, artifact.rel)
    findings.extend(decode_findings)
    if text is None:
        return findings

    if artifact.kind == "jsonl":
        findings.extend(_detect_jsonl(artifact, text))
    elif artifact.kind == "csv":
        findings.extend(_detect_csv(artifact, text))
    elif artifact.kind == "json":
        findings.extend(_detect_json(artifact, text))
    elif artifact.kind == "lock":
        findings.extend(_detect_lock(artifact, text))
    return findings


def _detect_jsonl(artifact: Artifact, text: str) -> list[Finding]:
    """Report unparseable records and repeated `unique_key` tuples."""
    findings: list[Finding] = []
    bad: list[tuple[int, str]] = []
    seen: dict[tuple, int] = {}
    duplicates: list[tuple[int, int, tuple]] = []
    for number, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except ValueError as error:
            bad.append((number, str(error)))
            continue
        if artifact.unique_key and isinstance(record, dict):
            key = tuple(record.get(field) for field in artifact.unique_key)
            if None not in key:
                if key in seen:
                    duplicates.append((number, seen[key], key))
                else:
                    seen[key] = number
    if bad:
        first = bad[0]
        findings.append(Finding(
            code="BAD_JSONL_LINE",
            rel=artifact.rel,
            kind=CORRUPTION,
            detail=(f"{len(bad)} unparseable record(s), first at line {first[0]}: {first[1]}"),
            line=first[0],
            repairable="QUARANTINE_LINES",
        ))
    if duplicates:
        first = duplicates[0]
        findings.append(Finding(
            code="DUPLICATE_KEY",
            rel=artifact.rel,
            kind=ADVISORY,
            detail=(f"{len(duplicates)} repeated {'+'.join(artifact.unique_key)} record(s),"
                    f" first duplicate at line {first[0]} repeating line {first[1]}"
                    f" {first[2]}; a re-run re-appends records hidden behind corrupt lines"),
            line=first[0],
            repairable="DEDUP",
        ))
    return findings


def _csv_rows(text: str) -> list[tuple[int, list[str], bool]]:
    """Return `(last physical line, fields, spans several lines)` per CSV row.

    A quoted field containing a newline makes one record span several physical
    lines, which line-level repair cannot split; callers refuse rather than
    guess where the record ends.

    @param text - Decoded CSV document.
    @returns One entry per parsed row, in document order.
    """
    reader = csv.reader(io.StringIO(text))
    rows: list[tuple[int, list[str], bool]] = []
    previous = 0
    for row in reader:
        end = reader.line_num
        rows.append((end, row, end - previous > 1))
        previous = end
    return rows


def _detect_csv(artifact: Artifact, text: str) -> list[Finding]:
    """Report rows whose field count disagrees with the header or `columns`."""
    rows = [(line, row, spans) for line, row, spans in _csv_rows(text) if row]
    if not rows:
        return []
    findings: list[Finding] = []
    expected = artifact.columns or len(rows[0][1])
    offenders = [(line, len(row)) for line, row, _ in rows if len(row) != expected]
    if offenders:
        first = offenders[0]
        findings.append(Finding(
            code="BAD_CSV_ROW",
            rel=artifact.rel,
            kind=CORRUPTION,
            detail=(f"{len(offenders)} row(s) with a field count other than {expected},"
                    f" first at line {first[0]} with {first[1]} field(s); a truncated"
                    " append is accepted as the row already being present"),
            line=first[0],
            repairable="QUARANTINE_LINES",
        ))
    if any(spans for _, _, spans in rows):
        findings.append(Finding(
            code="MULTILINE_CSV_FIELD",
            rel=artifact.rel,
            kind=ADVISORY,
            detail="a quoted field spans several physical lines; line-level repair refuses",
        ))
    return findings


def _detect_json(artifact: Artifact, text: str) -> list[Finding]:
    """Report a JSON document that does not parse as a whole."""
    try:
        json.loads(text)
    except ValueError as error:
        return [Finding(
            code="UNPARSEABLE_JSON",
            rel=artifact.rel,
            kind=CORRUPTION,
            detail=f"{len(text)} bytes do not parse: {error} (truncated write)",
            repairable="QUARANTINE_FILE",
        )]
    return []


def _detect_lock(artifact: Artifact, text: str) -> list[Finding]:
    """Classify a lock file as stale, lease-expired-but-live, or healthy.

    Only a holder that is provably gone, or lock content that cannot be read,
    is repairable without an explicit override: clearing a live holder's lock
    would break the single-writer discipline the lock exists to enforce.
    """
    try:
        lock = json.loads(text)
        pid = int(lock["pid"])
        started_at = float(lock["started_at"])
    except (ValueError, KeyError, TypeError) as error:
        return [Finding(
            code="UNREADABLE_LOCK",
            rel=artifact.rel,
            kind=CORRUPTION,
            detail=f"lock content is not a pid/started_at record: {error}",
            repairable="CLEAR_STALE_LOCK",
        )]
    if not pid_alive(pid):
        return [Finding(
            code="STALE_LOCK",
            rel=artifact.rel,
            kind=CORRUPTION,
            detail=f"holder pid {pid} is not running; the lock blocks every future run",
            repairable="CLEAR_STALE_LOCK",
        )]
    age = max(0.0, time.time() - started_at)
    if age > artifact.lease_seconds:
        return [Finding(
            code="LEASE_EXPIRED_LOCK",
            rel=artifact.rel,
            kind=ADVISORY,
            detail=(f"holder pid {pid} is alive but has held the lock for"
                    f" {age / 3600:.1f}h, past the {artifact.lease_seconds / 3600:.1f}h lease"),
            repairable="CLEAR_STALE_LOCK",
        )]
    return [Finding(
        code="LIVE_LOCK",
        rel=artifact.rel,
        kind=ADVISORY,
        detail=f"holder pid {pid} is alive and within its lease; never clear this lock",
    )]


def detect(contract: Contract, *, verifying: bool) -> list[Finding]:
    """Detect residue across every declared artifact.

    @param contract - Validated contract.
    @param verifying - True for `verify`, which also fails incomplete runs.
    @returns Findings ordered by contract position, then code.
    """
    findings: list[Finding] = []
    for pattern in contract.unmatched_globs:
        findings.append(Finding(
            code="GLOB_NO_MATCH",
            rel=pattern,
            kind=INCOMPLETENESS,
            detail=("required glob matched no artifact; the producing run has not"
                    " written them"),
        ))
    for artifact in contract.artifacts:
        findings.extend(detect_artifact(artifact, verifying=verifying))
    return findings


# --------------------------------------------------------------------------
# Repair
# --------------------------------------------------------------------------


def _stamp() -> str:
    """Return a filesystem-safe UTC timestamp for archive names."""
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _archive_path(path: Path, suffix: str) -> Path:
    """Return a collision-free archive path beside the artifact."""
    return path.with_name(f"{path.name}{suffix}-{_stamp()}")


def _write_atomic(path: Path, data: bytes) -> None:
    """Replace a file's contents as one rename, so a crash cannot truncate it."""
    temporary = path.with_name(f"{path.name}.repair-tmp-{os.getpid()}")
    temporary.write_bytes(data)
    os.replace(temporary, path)


def _terminated(line: str) -> str:
    """Return a line guaranteed to end with a newline, for rewritten files."""
    return line if line.endswith("\n") else line + "\n"


def _apply_append_final_newline(artifact: Artifact, actions: list[Action]) -> None:
    """Terminate a complete final record without dropping any of its bytes."""
    with open(artifact.path, "ab") as handle:
        handle.write(b"\n")
    actions.append(Action(
        code="APPEND_FINAL_NEWLINE",
        rel=artifact.rel,
        detail="terminated the final complete record; no bytes were dropped",
    ))


def _apply_truncate_partial_tail(artifact: Artifact, actions: list[Action]) -> None:
    """Drop an interrupted tail, keeping the dropped bytes as evidence."""
    data = artifact.path.read_bytes()
    cut = data.rfind(b"\n") + 1
    tail = data[cut:]
    archive = _archive_path(artifact.path, ".broken-tail")
    archive.write_bytes(tail)
    _write_atomic(artifact.path, data[:cut])
    actions.append(Action(
        code="TRUNCATE_PARTIAL_TAIL",
        rel=artifact.rel,
        detail=f"dropped {len(tail)} interrupted byte(s); file now ends with a newline",
        archive=str(archive),
    ))


def _apply_quarantine_file(artifact: Artifact, actions: list[Action]) -> None:
    """Move a wholly unusable artifact aside so the producer can recreate it."""
    archive = _archive_path(artifact.path, ".broken")
    os.replace(artifact.path, archive)
    actions.append(Action(
        code="QUARANTINE_FILE",
        rel=artifact.rel,
        detail="unusable artifact moved aside; the producing run must recreate it",
        archive=str(archive),
    ))


def _apply_quarantine_lines(artifact: Artifact, actions: list[Action]) -> None:
    """Keep parseable records, archiving the original and the rejected lines."""
    original = artifact.path.read_bytes()
    text, decode_findings = _decode(original, artifact.rel)
    if text is None:
        actions.append(Action(
            code="QUARANTINE_LINES",
            rel=artifact.rel,
            detail=f"skipped: {decode_findings[0].detail}",
        ))
        return
    raw = text.splitlines(keepends=True)
    keep_index: set[int] = set()
    rejected_index: set[int] = set()
    if artifact.kind == "jsonl":
        for index, line in enumerate(raw):
            if not line.strip():
                continue
            try:
                json.loads(line)
            except ValueError:
                rejected_index.add(index)
            else:
                keep_index.add(index)
    else:
        rows = _csv_rows(text)
        if any(spans for _, _, spans in rows):
            actions.append(Action(
                code="QUARANTINE_LINES",
                rel=artifact.rel,
                detail="refused: a quoted field spans several physical lines",
            ))
            return
        expected = artifact.columns or (len(rows[0][1]) if rows else 0)
        for line_number, row, _ in rows:
            if line_number - 1 >= len(raw):
                continue
            target = keep_index if len(row) == expected else rejected_index
            target.add(line_number - 1)
    if not rejected_index:
        actions.append(Action(
            code="QUARANTINE_LINES",
            rel=artifact.rel,
            detail="no unparseable record remained; nothing changed",
        ))
        return
    keep = [_terminated(raw[index]) for index in sorted(keep_index)]
    rejected = [_terminated(raw[index]) for index in sorted(rejected_index)]
    backup = _archive_path(artifact.path, ".bak")
    backup.write_bytes(original)
    archive = _archive_path(artifact.path, ".broken-lines")
    archive.write_text("".join(rejected), encoding="utf-8")
    _write_atomic(artifact.path, "".join(keep).encode("utf-8"))
    actions.append(Action(
        code="QUARANTINE_LINES",
        rel=artifact.rel,
        detail=(f"kept {len(keep)} record(s), quarantined {len(rejected)};"
                " dropped records are a semantic loss the operator must accept"),
        archive=str(archive),
    ))


def _apply_dedup(artifact: Artifact, actions: list[Action]) -> None:
    """Keep the first record per `unique_key`, archiving the original."""
    original = artifact.path.read_bytes()
    text, _ = _decode(original, artifact.rel)
    if text is None:
        return
    keep: list[str] = []
    rejected: list[str] = []
    seen: set[tuple] = set()
    for line in text.splitlines(keepends=True):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except ValueError:
            keep.append(line if line.endswith("\n") else line + "\n")
            continue
        key = tuple(record.get(field) for field in artifact.unique_key)
        if None not in key and key in seen:
            rejected.append(line if line.endswith("\n") else line + "\n")
            continue
        seen.add(key)
        keep.append(line if line.endswith("\n") else line + "\n")
    if not rejected:
        actions.append(Action(code="DEDUP", rel=artifact.rel, detail="no duplicate record"))
        return
    backup = _archive_path(artifact.path, ".bak")
    backup.write_bytes(original)
    archive = _archive_path(artifact.path, ".duplicates")
    archive.write_text("".join(rejected), encoding="utf-8")
    _write_atomic(artifact.path, "".join(keep).encode("utf-8"))
    actions.append(Action(
        code="DEDUP",
        rel=artifact.rel,
        detail=f"removed {len(rejected)} repeated record(s); first occurrence kept",
        archive=str(archive),
    ))


def _apply_clear_stale_lock(artifact: Artifact, actions: list[Action]) -> bool:
    """Clear a lock, refusing when the holder is alive and within its lease."""
    try:
        lock = json.loads(artifact.path.read_text(encoding="utf-8"))
        pid = int(lock["pid"])
        started_at = float(lock["started_at"])
        live_within_lease = pid_alive(pid) and (time.time() - started_at) <= artifact.lease_seconds
    except (OSError, ValueError, KeyError, TypeError):
        live_within_lease = False
    if live_within_lease:
        actions.append(Action(
            code="CLEAR_STALE_LOCK",
            rel=artifact.rel,
            detail="refused: the holder is alive and within its lease",
        ))
        return False
    archive = _archive_path(artifact.path, ".stale-lock")
    shutil.copyfile(artifact.path, archive)
    artifact.path.unlink()
    actions.append(Action(
        code="CLEAR_STALE_LOCK",
        rel=artifact.rel,
        detail="lock cleared; no live holder owns it",
        archive=str(archive),
    ))
    return True


def _resolve_plan(finding: Finding, options: argparse.Namespace) -> str | None:
    """Return the repair this run would perform for a finding.

    `DEFERRED` marks corruption that the requested tier flags cannot clear, so
    the verdict names the missing flag instead of leaving an unexplained
    failure. An advisory finding without its flag resolves to None: advisories
    never block a re-run and must not appear as pending work.

    @param finding - Finding under consideration.
    @param options - Parsed CLI options carrying the tier flags.
    @returns An action code, `DEFERRED`, or None for no action.
    """
    repair_code = finding.repairable
    if repair_code is None:
        return None
    if repair_code in ("APPEND_FINAL_NEWLINE", "TRUNCATE_PARTIAL_TAIL",
                       "QUARANTINE_FILE", "CLEAR_STALE_LOCK"):
        return repair_code
    if repair_code == "QUARANTINE_LINES":
        if options.quarantine_lines:
            return repair_code
    elif repair_code == "DEDUP":
        if options.dedup:
            return repair_code
    return "DEFERRED" if finding.kind == CORRUPTION else None


def repair(contract: Contract, findings: list[Finding], options: argparse.Namespace,
           actions: list[Action]) -> None:
    """Apply the repair policy to every corruption finding.

    @param contract - Validated contract.
    @param findings - Result of `detect` over the same contract.
    @param options - Parsed CLI options carrying the tier flags and `--dry-run`.
    @param actions - Appended in place; each entry records what changed.
    """
    by_rel = {artifact.rel: artifact for artifact in contract.artifacts}
    handled: set[tuple[str, str]] = set()
    for finding in findings:
        artifact = by_rel[finding.rel]
        key = (finding.rel, finding.repairable or "")
        plan = _resolve_plan(finding, options)
        if plan is None or key in handled:
            continue
        handled.add(key)
        if plan == "DEFERRED":
            actions.append(Action(
                code=finding.repairable or "UNKNOWN",
                rel=finding.rel,
                detail=(f"deferred: {finding.code} needs an explicit tier flag"
                        " (--quarantine-lines or --dedup)"),
                applied=False,
            ))
            continue
        if options.dry_run:
            actions.append(Action(
                code=plan,
                rel=finding.rel,
                detail=f"planned: would clear {finding.code}",
                applied=False,
                planned=True,
            ))
            continue
        if plan == "APPEND_FINAL_NEWLINE":
            _apply_append_final_newline(artifact, actions)
        elif plan == "TRUNCATE_PARTIAL_TAIL":
            _apply_truncate_partial_tail(artifact, actions)
        elif plan == "QUARANTINE_FILE":
            _apply_quarantine_file(artifact, actions)
        elif plan == "QUARANTINE_LINES":
            _apply_quarantine_lines(artifact, actions)
        elif plan == "DEDUP":
            _apply_dedup(artifact, actions)
        elif finding.code == "LEASE_EXPIRED_LOCK" and not options.force_live_lock:
            actions.append(Action(
                code="CLEAR_STALE_LOCK",
                rel=finding.rel,
                detail=("refused: lease expired but the holder is alive;"
                        " pass --force-live-lock to override"),
                applied=False,
            ))
        else:
            _apply_clear_stale_lock(artifact, actions)


# --------------------------------------------------------------------------
# Re-run
# --------------------------------------------------------------------------


def rerun(command: str, cwd: Path, timeout_seconds: float) -> dict:
    """Execute the producer's own entry point as the operator wrote it.

    The command comes from the operator's command line, never from the contract
    file, so a hostile or stale contract cannot trigger execution. It runs
    through the platform shell (`cmd /c`, `/bin/sh -c`) because an operator
    writes a command line, not an argument vector; passing that line as an argv
    list mangles every quoted path on Windows.

    @param command - Shell command line to re-run.
    @param cwd - Working directory for the re-run.
    @param timeout_seconds - Hard limit; the child is killed on expiry.
    @returns rc, timeout flag, and the last 20 output lines.
    """
    try:
        completed = subprocess.run(
            command, shell=True, cwd=str(cwd), capture_output=True, text=True,
            timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        return {"command": command, "rc": None, "timeout": True, "output": []}
    output = (completed.stdout + completed.stderr).splitlines()
    return {"command": command, "rc": completed.returncode, "timeout": False,
            "output": output[-20:]}


# --------------------------------------------------------------------------
# Reporting
# --------------------------------------------------------------------------


def inventory(contract: Contract) -> list[dict]:
    """Return per-artifact presence, kind, and size.

    A clean verdict is only evidence if it states what was inspected; the
    inventory is what makes the difference between "no residue" and "nothing
    was read" observable.

    @param contract - Validated contract.
    @returns One entry per declared artifact, in contract order.
    """
    entries: list[dict] = []
    for artifact in contract.artifacts:
        present = artifact.path.exists()
        entries.append({
            "rel": artifact.rel,
            "kind": artifact.kind,
            "role": artifact.role,
            "present": present,
            "bytes": artifact.path.stat().st_size if present else 0,
        })
    return entries


def report_payload(contract: Contract, phase: str, findings: list[Finding],
                   actions: list[Action], verdict: str,
                   rerun_result: dict | None = None) -> dict:
    """Build the machine-readable report shared by every subcommand."""
    entries = inventory(contract)
    return {
        "run": contract.run,
        "root": str(contract.root),
        "phase": phase,
        "verdict": verdict,
        "inspected": len(entries),
        "present": sum(1 for entry in entries if entry["present"]),
        "absent": sum(1 for entry in entries if not entry["present"]),
        "artifacts": entries,
        "findings": [asdict(finding) for finding in findings],
        "actions": [asdict(action) for action in actions],
        "rerun": rerun_result,
    }


def _ascii_safe() -> None:
    """控制台输出降级为当前编码可表示的字符。

    产物的路径、坏行内容或 JSON 解析错误里可能有中文（GBK 控制台编码不了）；若让
    `print` 抛 `UnicodeEncodeError`，工具会因为"报告的是一份中文文件"而崩掉。JSON
    输出用 `ensure_ascii=True`，机器可读面不受影响。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError, OSError):
            pass


def emit(payload: dict, output_format: str) -> None:
    """Write a report as JSON or as the operator-facing text form.

    The text form stays ASCII so it survives a console using a legacy code page,
    where non-ASCII punctuation renders as mojibake.
    """
    if output_format == "json":
        print(json.dumps(payload, ensure_ascii=True, indent=2))
        return
    print(f"run: {payload['run']}  phase: {payload['phase']}  verdict: {payload['verdict']}")
    print(f"  coverage: {payload['inspected']} artifact(s) inspected,"
          f" {payload['present']} present, {payload['absent']} absent")
    for finding in payload["findings"]:
        location = f":{finding['line']}" if finding["line"] else ""
        print(f"  [{finding['kind']}] {finding['code']} {finding['rel']}{location}"
              f" - {finding['detail']}")
    for action in payload["actions"]:
        marker = "applied" if action["applied"] else (
            "planned" if action.get("planned") else "deferred")
        print(f"  [{marker}] {action['code']} {action['rel']} - {action['detail']}")
        if action["archive"]:
            print(f"           evidence: {action['archive']}")
    if payload.get("rerun"):
        rerun_payload = payload["rerun"]
        print(f"  re-run rc={rerun_payload['rc']} timeout={rerun_payload['timeout']}"
              f" :: {rerun_payload['command']}")
    if not payload["findings"] and not payload["actions"]:
        print("  no residue detected")


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def run_command(args: argparse.Namespace) -> int:
    """Execute detect, repair, or verify and return the process exit code."""
    try:
        contract = load_contract(Path(args.contract).resolve(),
                                 Path(args.root).resolve() if args.root else None)
    except ContractError as error:
        print(f"contract error: {error}", file=sys.stderr)
        return 2

    verifying = args.command == "verify"
    findings = detect(contract, verifying=verifying)
    actions: list[Action] = []
    verdict = "clean"

    if args.command == "detect":
        verdict = "residue" if any(f.kind == CORRUPTION for f in findings) else "clean"
    elif args.command == "repair":
        repair(contract, findings, args, actions)
        residual = detect(contract, verifying=verifying)
        blocking = [f for f in residual if f.kind == CORRUPTION]
        if args.rerun:
            actions_result = rerun(args.rerun, contract.root, args.rerun_timeout)
            residual = detect(contract, verifying=True)
            blocking = [f for f in residual if f.kind in (CORRUPTION, INCOMPLETENESS)]
            verdict = "pass" if not blocking and actions_result["rc"] == 0 else "fail"
            findings = residual
            emit(report_payload(contract, args.command, findings, actions, verdict,
                                actions_result), args.format)
            return 0 if verdict == "pass" else 1
        verdict = "repaired" if not blocking else "residue"
        if args.dry_run:
            planned = {(action.rel, action.code) for action in actions if action.planned}
            blocking = [f for f in residual if f.kind == CORRUPTION
                        and (f.rel, f.repairable or "") not in planned]
            verdict = "planned" if not blocking else "residue"
        if args.verify:
            residual = detect(contract, verifying=True)
            blocking = [f for f in residual if f.kind in (CORRUPTION, INCOMPLETENESS)]
            findings = residual
            verdict = "pass" if not blocking else "residue"
    else:
        blocking = [f for f in findings if f.kind in (CORRUPTION, INCOMPLETENESS)]
        verdict = "pass" if not blocking else "fail"

    emit(report_payload(contract, args.command, findings, actions, verdict), args.format)
    if args.command == "detect":
        return 1 if any(f.kind == CORRUPTION for f in findings) else 0
    if args.command == "verify":
        return 0 if verdict == "pass" else 1
    return 0 if verdict in ("repaired", "clean", "planned") else 1


def build_parser() -> argparse.ArgumentParser:
    """Build the CLI parser for all four subcommands."""
    parser = argparse.ArgumentParser(
        prog="repair_interrupted_run.py",
        description="Detect, repair, and re-verify residue left by an interrupted run.")
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name, help_text in (
        ("detect", "report residue without changing anything"),
        ("repair", "apply the repair policy, optionally re-running the producer"),
        ("verify", "confirm the run is intact and complete"),
    ):
        sub = subparsers.add_parser(name, help=help_text)
        sub.add_argument("--contract", required=True, help="path to the run contract JSON")
        sub.add_argument("--root", help="artifact root (default: the contract's directory)")
        sub.add_argument("--format", choices=("text", "json"), default="text")
        if name == "repair":
            sub.add_argument("--dry-run", action="store_true",
                             help="plan the repairs without touching any file")
            sub.add_argument("--quarantine-lines", action="store_true",
                             help="tier 2: keep parseable lines, archive the rest")
            sub.add_argument("--dedup", action="store_true",
                             help="tier 3: keep the first record per unique_key")
            sub.add_argument("--force-live-lock", action="store_true",
                             help="clear a lock whose holder is alive past its lease")
            sub.add_argument("--verify", action="store_true",
                             help="re-verify completeness after repairing")
            sub.add_argument("--rerun", metavar="CMD",
                             help="producer command to run after repairing")
            sub.add_argument("--rerun-timeout", type=float, default=900.0,
                             help="seconds allowed for --rerun (default: 900)")
    subparsers.add_parser("selftest", help="build every residue case and assert the loop")
    return parser


# --------------------------------------------------------------------------
# Self-test: the acceptance evidence for this tool
# --------------------------------------------------------------------------


def _case(name: str) -> tuple[Path, Path]:
    """Create a fresh case directory and return (case dir, contract path)."""
    directory = Path(tempfile.mkdtemp(prefix=f"repair-case-{name}-"))
    return directory, directory / "contract.json"


def _write_contract(path: Path, artifacts: list[dict], run: str) -> None:
    """Write a contract file for a self-test case."""
    path.write_text(json.dumps({"run": run, "artifacts": artifacts}, indent=1),
                    encoding="utf-8")


def _detect_codes(contract_path: Path) -> tuple[int, list[str]]:
    """Run detect in-process and return (exit code, finding codes)."""
    contract = load_contract(contract_path, None)
    findings = detect(contract, verifying=False)
    codes = [finding.code for finding in findings]
    return (1 if any(f.kind == CORRUPTION for f in findings) else 0), codes


def _repair_codes(contract_path: Path, **flags: bool) -> tuple[int, list[Action], list[str]]:
    """Run repair in-process and return exit code, actions, and archive paths."""
    contract = load_contract(contract_path, None)
    options = argparse.Namespace(
        dry_run=False,
        quarantine_lines=flags.get("quarantine_lines", False),
        dedup=flags.get("dedup", False),
        force_live_lock=flags.get("force_live_lock", False),
        verify=False,
        rerun=None,
        rerun_timeout=900.0,
    )
    findings = detect(contract, verifying=False)
    actions: list[Action] = []
    repair(contract, findings, options, actions)
    residual = detect(contract, verifying=False)
    archives = [action.archive for action in actions if action.archive]
    blocked = any(f.kind == CORRUPTION for f in residual)
    return (1 if blocked else 0), actions, archives


def _action_codes(actions: list[Action]) -> list[str]:
    """Return the repair codes of applied actions, for case assertions."""
    return [action.code for action in actions]


def _run_cli(argv: list[str]) -> tuple[int, str]:
    """Run one CLI invocation in-process, capturing its report text.

    @param argv - Argument vector, without the program name.
    @returns The exit code and the report the command printed.
    """
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        code = run_command(build_parser().parse_args(argv))
    return code, buffer.getvalue()


def _make_dead_pid() -> int:
    """Return the pid of a process that has exited, for stale-lock fixtures."""
    child = subprocess.Popen([sys.executable, "-c", "pass"])
    child.wait()
    if not pid_alive(child.pid):
        return child.pid
    return 2 ** 31 - 1


def selftest() -> int:
    """Assert every residue case and both negative controls.

    Each case must reach `pass` through the same loop the skill prescribes:
    detect names the residue, repair clears it, the producer re-runs, and verify
    reports an intact complete run. The negative controls must stay untouched.

    @returns 0 when every case passes, 1 otherwise.
    """
    results: list[tuple[str, bool, str]] = []
    created: list[Path] = []

    def record(name: str, ok: bool, detail: str) -> None:
        results.append((name, ok, detail))

    def _new_case(name: str) -> tuple[Path, Path]:
        """Create a case directory and remember it for cleanup."""
        directory, contract_path = _case(name)
        created.append(directory)
        return directory, contract_path

    # 1. clean baseline: nothing to detect, nothing to repair.
    directory, contract_path = _new_case("clean")
    (directory / "day.jsonl").write_text('{"code":"A","at":1}\n{"code":"B","at":2}\n',
                                        encoding="utf-8")
    (directory / "closed").write_text('{"rows_written":2}', encoding="utf-8")
    _write_contract(contract_path, [
        {"path": "day.jsonl", "kind": "jsonl", "unique_key": ["code", "at"]},
        {"path": "closed", "kind": "json", "role": "completion-marker", "required": True},
    ], "clean")
    code, codes = _detect_codes(contract_path)
    _, actions, _ = _repair_codes(contract_path)
    _, report = _run_cli(["detect", "--contract", str(contract_path), "--format", "json"])
    payload = json.loads(report)
    record("clean baseline",
           code == 0 and codes == [] and actions == []
           and payload["inspected"] == 2 and payload["present"] == 2,
           f"detect={codes} actions={actions}"
           f" coverage={payload['present']}/{payload['inspected']}")

    # 2. interrupted jsonl tail: half a record, no newline.
    directory, contract_path = _new_case("partial-jsonl")
    (directory / "day.jsonl").write_text(
        '{"code":"A","at":1}\n{"code":"B","at":2}\n{"code":"C","at":', encoding="utf-8")
    _write_contract(contract_path,
                    [{"path": "day.jsonl", "kind": "jsonl"}], "partial-jsonl")
    code, codes = _detect_codes(contract_path)
    ok_detect = code == 1 and "PARTIAL_LAST_LINE" in codes and "BAD_JSONL_LINE" in codes
    code, actions, archives = _repair_codes(contract_path, quarantine_lines=True)
    text = (directory / "day.jsonl").read_text(encoding="utf-8")
    record("partial jsonl tail", ok_detect and code == 0 and text.endswith("\n")
           and "A" in text and "B" in text and "C" not in text and bool(archives),
           f"detect={codes} actions={actions}")

    # 3. complete record with a missing newline: the next append concatenates.
    directory, contract_path = _new_case("no-newline")
    (directory / "day.jsonl").write_text('{"code":"A","at":1}\n{"code":"B","at":2}',
                                        encoding="utf-8")
    _write_contract(contract_path, [{"path": "day.jsonl", "kind": "jsonl"}], "no-newline")
    code, codes = _detect_codes(contract_path)
    code2, actions, _ = _repair_codes(contract_path)
    body = (directory / "day.jsonl").read_text(encoding="utf-8")
    record("record without newline",
           code == 1 and codes == ["MISSING_FINAL_NEWLINE"] and code2 == 0
           and body.count("\n") == 2 and '"B"' in body and actions != [],
           f"detect={codes} actions={_action_codes(actions)}")

    # 4. two records concatenated on one line by an earlier interrupted append.
    directory, contract_path = _new_case("concatenated")
    (directory / "day.jsonl").write_text(
        '{"code":"A","at":1}\n{"code":"B","at":2}{"code":"C","at":3}\n', encoding="utf-8")
    _write_contract(contract_path, [{"path": "day.jsonl", "kind": "jsonl"}], "concatenated")
    code, codes = _detect_codes(contract_path)
    tier1_code, tier1_actions, _ = _repair_codes(contract_path)
    _, actions2, archives2 = _repair_codes(contract_path, quarantine_lines=True)
    body = (directory / "day.jsonl").read_text(encoding="utf-8")
    record("concatenated records",
           code == 1 and codes == ["BAD_JSONL_LINE"] and tier1_code == 1
           and any("deferred" in action.detail for action in tier1_actions)
           and "QUARANTINE_LINES" in _action_codes(actions2) and "A" in body and "C" not in body
           and bool(archives2),
           f"detect={codes} tier1={tier1_actions} tier2={actions2}")

    # 5. truncated csv row: the day is already present, so the row never returns.
    directory, contract_path = _new_case("csv")
    (directory / "prices.csv").write_text("date,n,mean,std\n2026-09-24,113,0.01,0.02\n"
                                         "2026-09-25,113,0.0", encoding="utf-8")
    _write_contract(contract_path,
                    [{"path": "prices.csv", "kind": "csv", "columns": 4}], "csv")
    code, codes = _detect_codes(contract_path)
    _, actions, archives = _repair_codes(contract_path, quarantine_lines=True)
    body = (directory / "prices.csv").read_text(encoding="utf-8")
    record("truncated csv row",
           code == 1 and "BAD_CSV_ROW" in codes and "PARTIAL_LAST_LINE" in codes
           and "2026-09-25" not in body and len(archives) >= 1,
           f"detect={codes} actions={actions}")

    # 6. zero-byte completion marker: existence-only readers call the run done.
    directory, contract_path = _new_case("empty-marker")
    (directory / "closed_2026-09-25").write_text("", encoding="utf-8")
    (directory / "day.jsonl").write_text('{"code":"A","at":1}\n', encoding="utf-8")
    _write_contract(contract_path, [
        {"path": "closed_2026-09-25", "kind": "json", "role": "completion-marker",
         "required": True},
        {"path": "day.jsonl", "kind": "jsonl"},
    ], "empty-marker")
    code, codes = _detect_codes(contract_path)
    repair_code, actions, archives = _repair_codes(contract_path)
    verify_contract = load_contract(contract_path, None)
    verify_codes = [f.code for f in detect(verify_contract, verifying=True)]
    record("empty completion marker",
           code == 1 and "EMPTY_MARKER" in codes and repair_code == 0
           and not (directory / "closed_2026-09-25").exists()
           and "MISSING_ARTIFACT" in verify_codes and bool(archives),
           f"detect={codes} actions={actions} verify={verify_codes}")

    # 7. truncated manifest: a swallowing reader silently drops earlier days.
    directory, contract_path = _new_case("json")
    (directory / "manifest.json").write_text('{"days":{"2026-09-24":{"n":113}}', encoding="utf-8")
    _write_contract(contract_path, [{"path": "manifest.json", "kind": "json"}], "json")
    code, codes = _detect_codes(contract_path)
    _, actions, archives = _repair_codes(contract_path)
    record("truncated json document",
           code == 1 and codes == ["UNPARSEABLE_JSON"]
           and _action_codes(actions) == ["QUARANTINE_FILE"]
           and not (directory / "manifest.json").exists() and bool(archives),
           f"detect={codes} actions={_action_codes(actions)}")

    # 8. lock held by a process that no longer exists.
    directory, contract_path = _new_case("stale-lock")
    dead = _make_dead_pid()
    (directory / "close.lock").write_text(
        json.dumps({"pid": dead, "started_at": time.time() - 60}), encoding="utf-8")
    _write_contract(contract_path,
                    [{"path": "close.lock", "kind": "lock", "lease_seconds": 3600}], "stale-lock")
    code, codes = _detect_codes(contract_path)
    repair_code, actions, archives = _repair_codes(contract_path)
    record("stale lock from a dead holder",
           code == 1 and codes == ["STALE_LOCK"] and repair_code == 0
           and _action_codes(actions) == ["CLEAR_STALE_LOCK"]
           and not (directory / "close.lock").exists() and bool(archives),
           f"detect={codes} actions={_action_codes(actions)}")

    # 9. negative control: a live holder's lock must survive an aggressive repair.
    directory, contract_path = _new_case("live-lock")
    (directory / "close.lock").write_text(
        json.dumps({"pid": os.getpid(), "started_at": time.time() - 10}), encoding="utf-8")
    _write_contract(contract_path,
                    [{"path": "close.lock", "kind": "lock", "lease_seconds": 3600}], "live-lock")
    code, codes = _detect_codes(contract_path)
    repair_code, actions, _ = _repair_codes(
        contract_path, quarantine_lines=True, dedup=True, force_live_lock=True)
    record("live lock is never cleared",
           code == 0 and codes == ["LIVE_LOCK"] and (directory / "close.lock").exists()
           and actions == [] and repair_code == 0,
           f"detect={codes} actions={actions}")

    # 10. advisory duplicates from a re-run that could not see a corrupt record.
    directory, contract_path = _new_case("duplicate")
    (directory / "day.jsonl").write_text(
        '{"code":"A","at":1}\n{"code":"A","at":1}\n{"code":"B","at":2}\n', encoding="utf-8")
    _write_contract(contract_path,
                    [{"path": "day.jsonl", "kind": "jsonl", "unique_key": ["code", "at"]}],
                    "duplicate")
    code, codes = _detect_codes(contract_path)
    _, actions, _ = _repair_codes(contract_path)
    repair_code, actions2, archives2 = _repair_codes(contract_path, dedup=True)
    body = (directory / "day.jsonl").read_text(encoding="utf-8")
    record("duplicate records",
           code == 0 and codes == ["DUPLICATE_KEY"] and actions == []
           and repair_code == 0 and "DEDUP" in _action_codes(actions2)
           and body.count('"A"') == 1 and bool(archives2),
           f"detect={codes} tier1={_action_codes(actions)}"
           f" tier3={_action_codes(actions2)}")

    # 11. a truncated multi-byte tail must not crash the detector.
    directory, contract_path = _new_case("multibyte")
    (directory / "note.jsonl").write_bytes('{"code":"A","at":1}\n{"note":"中'.encode("utf-8")[:-1])
    _write_contract(contract_path, [{"path": "note.jsonl", "kind": "jsonl"}], "multibyte")
    code, codes = _detect_codes(contract_path)
    record("truncated multi-byte tail",
           code == 1 and "UNDECODABLE_BYTES" in codes and "PARTIAL_LAST_LINE" in codes,
           f"detect={codes}")

    # 12. contract paths must stay inside the root.
    directory, contract_path = _new_case("escape")
    _write_contract(contract_path, [{"path": "../outside.jsonl", "kind": "jsonl"}], "escape")
    try:
        load_contract(contract_path, None)
        record("path escape rejected", False, "contract accepted an escaping path")
    except ContractError as error:
        record("path escape rejected", "escapes the root" in str(error), str(error))

    # 13. interrupted-write temp file beside an intact target.
    directory, contract_path = _new_case("orphan-temp")
    (directory / "manifest.json").write_text('{"days":{}}', encoding="utf-8")
    (directory / "manifest.json.repair-tmp-999").write_text('{"days":{"partial"', encoding="utf-8")
    _write_contract(contract_path, [{"path": "manifest.json", "kind": "json"}], "orphan-temp")
    code, codes = _detect_codes(contract_path)
    record("orphan temp tolerated",
           code == 0 and codes == [] and (directory / "manifest.json").exists(),
           f"detect={codes}")

    # 14. the full loop, including a real re-run of the producer.
    directory, contract_path = _new_case("rerun")
    (directory / "day.jsonl").write_text('{"code":"A","at":1}\n{"code":"B","at":', encoding="utf-8")
    (directory / "closed").write_text("", encoding="utf-8")
    _write_contract(contract_path, [
        {"path": "day.jsonl", "kind": "jsonl", "unique_key": ["code", "at"]},
        {"path": "closed", "kind": "json", "role": "completion-marker", "required": True},
    ], "rerun")
    producer = directory / "producer.py"
    producer.write_text(
        "import json, pathlib\n"
        "root = pathlib.Path(__file__).parent\n"
        "day = root / 'day.jsonl'\n"
        "records = [json.loads(line) for line in day.read_text(encoding='utf-8').splitlines()"
        " if line.strip()]\n"
        "if not any(r['code'] == 'B' for r in records):\n"
        "    with open(day, 'a', encoding='utf-8') as handle:\n"
        "        handle.write(json.dumps({'code': 'B', 'at': 2}) + '\\n')\n"
        "(root / 'closed').write_text(json.dumps({'rows_written': 2}))\n",
        encoding="utf-8")
    code, _ = _run_cli([
        "repair", "--contract", str(contract_path), "--format", "json",
        "--quarantine-lines", "--rerun", f'"{sys.executable}" "{producer}"'])
    contract = load_contract(contract_path, None)
    final = [f.code for f in detect(contract, verifying=True)]
    record("full loop with re-run",
           code == 0 and final == []
           and '"B"' in (directory / "day.jsonl").read_text(encoding="utf-8"),
           f"exit={code} verify={final}")

    # 15. a second repair pass over repaired artifacts changes nothing.
    directory, contract_path = _new_case("idempotent")
    (directory / "day.jsonl").write_text(
        '{"code":"A","at":1}\nnot json\n{"code":"B","at":2}\n', encoding="utf-8")
    _write_contract(contract_path, [{"path": "day.jsonl", "kind": "jsonl"}], "idempotent")
    first_code, first_actions, _ = _repair_codes(contract_path, quarantine_lines=True)
    after_first = (directory / "day.jsonl").read_bytes()
    second_code, second_actions, _ = _repair_codes(contract_path, quarantine_lines=True)
    record("repair is idempotent",
           first_code == 0 and _action_codes(first_actions) == ["QUARANTINE_LINES"]
           and second_code == 0 and second_actions == []
           and (directory / "day.jsonl").read_bytes() == after_first,
           f"first={_action_codes(first_actions)} second={_action_codes(second_actions)}")

    # 16. a dry run plans what the flags would clear and writes nothing.
    directory, contract_path = _new_case("dry-run")
    (directory / "day.jsonl").write_text(
        '{"code":"A","at":1}\nnot json\n', encoding="utf-8")
    _write_contract(contract_path, [{"path": "day.jsonl", "kind": "jsonl"}], "dry-run")
    before = (directory / "day.jsonl").read_bytes()
    without_flag, _ = _run_cli(
        ["repair", "--contract", str(contract_path), "--dry-run", "--format", "json"])
    with_flag, report = _run_cli(
        ["repair", "--contract", str(contract_path), "--dry-run", "--quarantine-lines",
         "--format", "json"])
    unchanged = (directory / "day.jsonl").read_bytes() == before
    record("dry run plans without writing",
           without_flag == 1 and with_flag == 0 and unchanged
           and '"verdict": "planned"' in report,
           f"without-flag={without_flag} with-flag={with_flag} unchanged={unchanged}")

    # 17. a glob contract covers every day a chain produces, including tomorrow's.
    directory, contract_path = _new_case("glob")
    (directory / "day_2026-09-24.jsonl").write_text('{"code":"A","at":1}\n', encoding="utf-8")
    (directory / "day_2026-09-25.jsonl").write_text(
        '{"code":"B","at":2}\n{"code":"C","at":', encoding="utf-8")
    (directory / "day_rejects.jsonl").write_text('{"day":"2026-09-23","reason":"x"}\n',
                                                encoding="utf-8")
    _write_contract(contract_path, [
        {"glob": "day_????-??-??.jsonl", "kind": "jsonl", "unique_key": ["code", "at"]},
        {"glob": "closed_*", "kind": "json", "role": "completion-marker"},
    ], "glob")
    code, codes = _detect_codes(contract_path)
    repair_code, _, _ = _repair_codes(contract_path, quarantine_lines=True)
    _, report = _run_cli(["detect", "--contract", str(contract_path), "--format", "json"])
    payload = json.loads(report)
    body = (directory / "day_2026-09-25.jsonl").read_text(encoding="utf-8")
    record("glob contract",
           code == 1 and "PARTIAL_LAST_LINE" in codes and repair_code == 0
           and payload["inspected"] == 2 and payload["present"] == 2
           and body.count("\n") == 1 and '"B"' in body,
           f"detect={codes} coverage={payload['present']}/{payload['inspected']}")

    # 18. a required glob that matches nothing is incompleteness, not silence.
    directory, contract_path = _new_case("glob-empty")
    _write_contract(contract_path, [
        {"glob": "closed_*", "kind": "json", "role": "completion-marker", "required": True},
    ], "glob-empty")
    detect_code, codes = _detect_codes(contract_path)
    verify_code, _ = _run_cli(["verify", "--contract", str(contract_path), "--format", "json"])
    record("required glob with no match",
           detect_code == 0 and codes == ["GLOB_NO_MATCH"] and verify_code == 1,
           f"detect={codes} verify_exit={verify_code}")

    print("repair_interrupted_run selftest")
    failures = 0
    for name, ok, detail in results:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}: {detail}")
        failures += 0 if ok else 1
    print(f"  {len(results) - failures}/{len(results)} case(s) passed")
    if failures:
        print("  failing case directories kept for inspection:")
        for directory in created:
            print(f"    {directory}")
    else:
        for directory in created:
            shutil.rmtree(directory, ignore_errors=True)
    return 1 if failures else 0


def main(argv: list[str] | None = None) -> int:
    """Parse arguments and dispatch to the selected subcommand."""
    args = build_parser().parse_args(argv)
    _ascii_safe()
    if args.command == "selftest":
        return selftest()
    return run_command(args)


if __name__ == "__main__":
    raise SystemExit(main())
