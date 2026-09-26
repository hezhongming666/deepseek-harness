---
name: dsh-interrupted-run-repair
description: Repair the on-disk residue an interrupted, killed, or crashed run leaves behind, then re-run the producer and verify the result. Detect a half-written JSONL or CSV line, a record whose terminating newline was lost, a JSON document truncated by a non-atomic rewrite, a zero-byte completion marker that existence-only readers accept, a lock file whose holder is dead, and duplicate records a re-run appended because a corrupt line hid them. Use before re-running any job that appends to or rewrites files — a plain re-run either fails again deterministically or silently accepts the damage. Chinese-speaking operators phrase this as 意外中断后复跑、半截文件、残留、定案没跑成.
---

# Interrupted-run repair

A killed writer leaves residue that a plain re-run does not clear. Two failure directions matter, and they need opposite handling:

- The residue **breaks the re-run**: an unparseable record makes the reader that aggregates the file raise on every attempt, so the artifact never completes and every retry fails on the same line.
- The residue **fools the re-run**: a truncated record, an empty completion marker, or a silently reset JSON document is read as success, so the damage survives re-running.

Work from a **run contract** — the artifact list the run claims to produce — so the tool never guesses which files matter, and never touches a file the run does not own.

## Procedure

1. **Stop the writer.** Repair is only safe when the interrupted producer is no longer running. If the contract declares a lock, `detect` reports the holder's pid and whether it is alive; never repair past `LIVE_LOCK`.
2. **Detect.** `detect` is read-only and must run first, so the report is evidence of the state before any byte changed.
3. **Repair at the narrowest tier that clears the corruption.** Tier 1 never drops a record; tier 2 and tier 3 do, so a repair that used them must disclose the loss in the final report rather than presenting a clean verdict as undamaged.
4. **Re-run the producer's own entry point**, not a hand-written fixup. Pass it through `--rerun` to record the command, its exit code, and its output in the same report; the command comes from the command line and is never read from the contract file.
5. **Verify.** `verify` fails both on corruption and on incompleteness, so it answers "did the re-run finish the job", not only "is the file parseable". A remaining `MISSING_ARTIFACT` means the producer has not finished; do not hand-edit an artifact to satisfy it.

## Commands

```sh
SKILL_DIR=/absolute/path/to/this/skill
python3 "$SKILL_DIR/scripts/repair_interrupted_run.py" detect --contract run.json
python3 "$SKILL_DIR/scripts/repair_interrupted_run.py" repair --contract run.json --dry-run
python3 "$SKILL_DIR/scripts/repair_interrupted_run.py" repair --contract run.json \
  --quarantine-lines --rerun "python scripts/collect_orderbook.py --close-due"
python3 "$SKILL_DIR/scripts/repair_interrupted_run.py" verify --contract run.json
python3 "$SKILL_DIR/scripts/repair_interrupted_run.py" selftest
python3 "$SKILL_DIR/scripts/audit_interruption_hazards.py" src/ --root . --contract run.json
python3 "$SKILL_DIR/scripts/audit_interruption_hazards.py" --selftest
python3 "$SKILL_DIR/scripts/hazard_guard.py" --roots src --root . --baseline base.json \
  --contract run.json --min-severity high --notify-cmd "python notify.py" --exit-code-new 6
python3 "$SKILL_DIR/scripts/hazard_guard.py" --selftest
```

`python3` is not present on every Windows host (the Store alias errors out); use `python` there. Exit codes: `0` clean or complete, `1` residue or an incomplete run, `2` usage or contract error. Both scanners also exit `2` when a target does not exist or the scan reaches no Python file, because a renamed directory would otherwise report a clean audit forever; `--allow-empty` accepts that scan when it is genuinely intended.

## The contract

```json
{
  "run": "orderbook-close-2026-09-25",
  "artifacts": [
    {"path": "state/day_2026-09-25.jsonl", "kind": "jsonl", "unique_key": ["code", "at"]},
    {"path": "panel/prices/SH600104.csv", "kind": "csv", "columns": 4},
    {"path": "panel/manifest.json", "kind": "json"},
    {"path": "state/closed_2026-09-25", "kind": "json", "role": "completion-marker", "required": true},
    {"path": "state/close.lock", "kind": "lock", "lease_seconds": 43200}
  ]
}
```

| Field | Meaning |
|---|---|
| `path` | Relative to `--root` (default: the contract file's directory). A path resolving outside the root is rejected, exit 2. |
| `glob` | Alternative to `path`: a relative pattern expanded against `--root` (files only, sorted) so a daily chain's contract covers artifacts that do not exist yet. `day_????-??-??.jsonl` keeps a `day_rejects.jsonl` registration file out, exactly as a strict day-file check does. With `required`, matching nothing is reported as `GLOB_NO_MATCH`. |
| `kind` | `jsonl`, `csv`, `json`, `lock`, or `text`. Each kind decides what "a whole record" means. |
| `unique_key` | Record fields that must not repeat; enables duplicate detection on a `jsonl` artifact. |
| `columns` | Expected CSV field count; defaults to the header's length. |
| `role` | `completion-marker` marks the run as finished by existing, which is why an empty marker is corruption. |
| `required` | A missing artifact is reported as incompleteness rather than passing silently. |
| `lease_seconds` | Age past which a lock held by a still-live process is reported (default 43200). |

## Auditing the source that produces the residue

Repair fixes a tree; `scripts/audit_interruption_hazards.py` finds the code that will keep producing the same residue. Run it before a re-run is ever needed, when reviewing a writer, or when deciding what to fix upstream.

| Pattern | What an interruption does |
|---|---|
| `UNGUARDED_WHOLE_FILE_PARSE` | an appended file parsed as one comprehension: one bad line raises on every later attempt |
| `SILENT_RESET_ON_CORRUPT` | a handler replaces a loaded document with a fresh empty one, dropping history |
| `NON_ATOMIC_OVERWRITE` | `write_text` / `open(..., "w")` truncates before writing, so a kill leaves a half document |
| `EXISTENCE_ONLY_CHECK` | `exists()` as the completion test, which a zero-byte file also satisfies |
| `UNGUARDED_APPEND_READ` | a read-then-append cycle with no lock in the enclosing function |
| `UNGUARDED_DECODE` | `read_text()` without `errors=`, so a truncated multi-byte tail raises |

Detection is AST-based and precision-first: `NON_ATOMIC_OVERWRITE` only escalates to `medium` when the **same file** reads that path back (a name like `OUT` is a different artifact in every script), and a handler that records what failed (`{"parse": "failed"}`, `{"message": raw[:200]}`) is disclosure, not a silent reset. Findings carry file, line, the matched source, why it matters, and the fix. **Verify every `high` by reading the code before reporting it** — the heuristic pairs listed above each had real false positives until they were tightened, and the remaining ones are named in `references/cases.md`.

### Declare the durable artifacts with a contract

`--contract run.json` turns the run contract into the **artifact graph**: file paths that other code treats as durable outputs. The scanner then escalates a truncate-and-write in *any* file that references a declared artifact — including a writer in one script whose reader lives in another, which the same-file rule cannot see — and suppresses advisories far from any declared artifact.

Measured on a 284-file Python pipeline with 16 declared artifacts: `medium` 35 → **61** (recall up on cross-file writers, e.g. a trials ledger written by one runner and read by a reviewer) and `advisory` 605 → **69** (510 suppressed noise). Contract contents are the caller's; the tool never invents artifacts.

### Guard against new hazards only

`hazard_guard.py` holds a baseline and alarms on **new** findings, because re-reporting the same list every day is not a signal. Identity is `pattern + severity + relative path + normalized evidence line + occurrence index`:

- no line number — line numbers drift with unrelated edits, and including them would flood every run with fake "new" items;
- an occurrence index — two identical hazard lines in one file stay distinguishable, so adding a third is still seen;
- severity — an advisory that escalates to `medium` (for example once a file is declared durable) is a regression and is reported.

The tool binds no alerting channel and no exit-code convention: `--notify-cmd` receives the alert body on stdin (and a one-line summary in `HAZARD_GUARD_SUMMARY`), `--min-severity` sets the alert threshold, and `--exit-code-new` pins the code so an existing scheduler keeps its own convention. `--update-baseline` is a human act and must follow a decision to accept the current state.

An empty scan exits `2` and records nothing, including under `--update-baseline`: a directory renamed out from under the guard would otherwise report clean forever, and an empty baseline would delete the very identities that make a later regression visible. `--allow-empty` is the explicit opt-out.


## Findings and repair tiers

Findings carry one of three kinds: **corruption** blocks or falsifies a re-run, **incompleteness** only a producer re-run can clear, and **advisory** is reported for judgement and never fails a run.

| Finding | Kind | Repair |
|---|---|---|
| `PARTIAL_LAST_LINE` | corruption | `TRUNCATE_PARTIAL_TAIL` — the final chunk is not a whole record, so it is dropped and archived |
| `MISSING_FINAL_NEWLINE` | corruption | `APPEND_FINAL_NEWLINE` — the final record is whole and only lost its newline, so it is terminated and no byte is dropped |
| `BAD_JSONL_LINE` | corruption | `QUARANTINE_LINES` (tier 2) |
| `BAD_CSV_ROW` | corruption | `QUARANTINE_LINES` (tier 2); refused when a quoted field spans several physical lines |
| `UNPARSEABLE_JSON` | corruption | `QUARANTINE_FILE` |
| `EMPTY_MARKER`, `EMPTY_FILE`, `UNDECODABLE_BYTES` | corruption | `QUARANTINE_FILE` |
| `STALE_LOCK`, `UNREADABLE_LOCK` | corruption | `CLEAR_STALE_LOCK` — only when the holder is provably gone or the content is unreadable |
| `MISSING_ARTIFACT` | incompleteness | none; the producer must run |
| `GLOB_NO_MATCH` | incompleteness | none; a required pattern matched nothing, so the producer must run |
| `DUPLICATE_KEY` | advisory | `DEDUP` (tier 3) |
| `LEASE_EXPIRED_LOCK` | advisory | `CLEAR_STALE_LOCK` with `--force-live-lock` |
| `LIVE_LOCK`, `MULTILINE_CSV_FIELD` | advisory | none |

Tiers: **tier 1** (default) terminates a record, truncates an interrupted tail, quarantines a wholly unusable file, and clears a provably dead lock. **Tier 2** (`--quarantine-lines`) copies the original aside and keeps only parseable records. **Tier 3** (`--dedup`) keeps the first record per `unique_key`. Every action writes its own archive next to the artifact — `.broken`, `.broken-tail`, `.broken-lines`, `.duplicates`, `.bak`, `.stale-lock` — and reports the path, so nothing is destroyed silently.

## Invariants

- Every report states its coverage — how many declared artifacts were inspected, present, and absent — so a clean verdict is falsifiable rather than silence.
- Detection never writes; `--dry-run` writes nothing and exits `1` when the requested flags cannot clear the corruption, so a plan never overstates what the flags do.
- No repair invents content or rewrites a record's meaning. Tier 2 and tier 3 drop records, which is a semantic loss the operator must accept.
- Every repair is idempotent: a second pass over repaired artifacts performs no action.
- A lock whose holder is alive is never cleared, not even past its lease, without `--force-live-lock`.
- Artifact paths stay inside `--root`.
- When an artifact holds data the producer cannot regenerate, stop and ask the operator before repairing: repair changes the artifact, and the archive is evidence, not a restore path.

## Verification

`scripts/repair_interrupted_run.py selftest` builds every case in a temporary directory and asserts the whole loop for each one — detect names the residue, repair clears it, the producer re-runs, verify reports an intact complete run — plus the negative controls that must stay untouched (clean artifacts, a live lock, an orphan temp file) and the guards (repair idempotence, dry-run silence, path escape). It exits non-zero on any failure and needs no fixtures on disk.

`scripts/audit_interruption_hazards.py --selftest` asserts that each hazard pattern fires on its fixture and stays quiet on its safe twin — the atomic writer, the per-line guarded parse, the locked append cycle — that a contract escalates a declared-artifact writer while suppressing advisories elsewhere, and that a missing target or an empty scan fails loud. `scripts/hazard_guard.py --selftest` asserts the guard's contract: baseline writes, known hazards stay quiet, a new hazard reaches the caller's exit code with the alert body on the notifier's stdin, a line shift is not new, an added duplicate is, the severity threshold is honoured, a severity escalation to a declared artifact is reported, and an empty scan neither reports clean nor overwrites the baseline.

All three tools reconfigure their own console streams to `errors="replace"` before printing: scanned source can contain text the console's code page cannot encode, and a tool must not crash while reporting a file whose comments are non-ASCII. Their JSON output is `ensure_ascii=True`, so the machine-readable surface is unaffected. None of these self-tests is wired into a `pnpm` gate, which would put a Python runtime requirement into the static gate set. [cases.md](references/cases.md) maps each repair case to the real-world residue that motivated it.
