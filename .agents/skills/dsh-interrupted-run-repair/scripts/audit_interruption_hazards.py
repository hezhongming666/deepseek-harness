#!/usr/bin/env python3
"""Static audit for interruption hazards: code that turns a kill into permanent damage.

`repair_interrupted_run.py` repairs residue that already exists. This scans the
source that *produces* it, so the hazard is found before the run is killed:

    UNGUARDED_WHOLE_FILE_PARSE  a whole appended file parsed as one list
                                comprehension, so one interrupted line makes
                                every later run raise on the same bytes.
    SILENT_RESET_ON_CORRUPT     `except` that replaces a loaded document with a
                                fresh empty one, silently dropping history.
    NON_ATOMIC_OVERWRITE        `write_text` / `open(..., "w")`, which truncate
                                before writing, so a kill leaves a half file.
    EXISTENCE_ONLY_CHECK        `exists()` used as the completion test for a file
                                another writer creates by truncate-and-write.
    UNGUARDED_APPEND_READ       a read-then-append cycle on the same path with no
                                lock in the enclosing function, so overlapping
                                runs append the same records twice.
    UNGUARDED_DECODE            `read_text()` without `errors=`, so an interrupted
                                multi-byte write raises instead of being disclosed.

Detection is AST-based and precision-first: a pattern is reported only when the
shape is unambiguous, and every finding carries the source line that matched.
`--selftest` proves each pattern fires on a fixture and stays quiet on its safe
counterpart.

Usage:
    python3 scripts/audit_interruption_hazards.py PATH [PATH ...] [--format json]
    python3 scripts/audit_interruption_hazards.py --selftest

A target that does not exist, or a scan that reaches no Python file, exits 2
instead of reporting a clean audit; `--allow-empty` accepts the empty scan when
that is genuinely the intent.

Exit codes: 0 no high or medium finding, 1 findings present, 2 usage error.
"""

from __future__ import annotations

import argparse
import ast
import contextlib
import io
import json
import sys
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path

HIGH = "high"
MEDIUM = "medium"
ADVISORY = "advisory"

SKIP_DIRS = {".git", ".venv", "__pycache__", "node_modules", ".pytest_cache",
             ".ruff_cache", ".mypy_cache", "site-packages"}


@dataclass(frozen=True)
class Finding:
    """One hazard site.

    @param code - Stable identifier callers assert on.
    @param severity - `high`, `medium`, or `advisory`.
    @param path - File the site lives in.
    @param line - 1-based line of the matched node.
    @param evidence - The matched source line, stripped.
    @param why - What an interruption does at this site.
    @param fix - The repair that removes the hazard.
    @param key - The path expression the site names, when the site names one.
        Matching is by this exact key, never by substring: a loose match would
        promote every `out.write_text(...)` that shares a word with some other
        file's read.
    """

    code: str
    severity: str
    path: str
    line: int
    evidence: str
    why: str
    fix: str
    key: str | None = None
    declared: bool = False


def _ascii_safe() -> None:
    """控制台输出降级为当前编码可表示的字符。

    被扫到的源码里可能有中文注释、路径或字符串（GBK 控制台编码不了），若让 `print`
    直接抛 `UnicodeEncodeError`，工具会因为在**报告**一个中文项目而崩掉。JSON 输出
    用 `ensure_ascii=True`，因此机器可读面不受影响。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError, OSError):
            pass


def _path_key(node: ast.AST) -> str | None:
    """Return the stable, comparable name of a path expression.

    Only expressions that name a location without depending on runtime values
    are keyed, because the cross-file read/write matching below compares these
    strings: a `Name` (`MANIFEST`), an `Attribute` chain (`self.cache`), and a
    literal string all qualify; anything computed returns None and is audited on
    its own file only.

    @param node - Expression node to key.
    @returns The key, or None when the expression is not a stable location.
    """
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Attribute):
        base = _path_key(node.value)
        return f"{base}.{node.attr}" if base else None
    return None


def _line_index(source_lines: list[str]) -> callable:
    """Return a lookup from a node to its stripped source line."""
    def lookup(node: ast.AST) -> str:
        line = getattr(node, "lineno", 1)
        return source_lines[line - 1].strip() if 0 < line <= len(source_lines) else ""
    return lookup


def _call_mode(node: ast.Call) -> str | None:
    """Return the mode literal of an `open()` call, or None when not one."""
    if not isinstance(node.func, ast.Name) or node.func.id != "open":
        return None
    if len(node.args) > 1 and isinstance(node.args[1], ast.Constant):
        value = node.args[1].value
        return value if isinstance(value, str) else None
    for keyword in node.keywords:
        if keyword.arg == "mode" and isinstance(keyword.value, ast.Constant):
            return keyword.value.value if isinstance(keyword.value.value, str) else None
    return None


def _is_method(node: ast.Call, name: str) -> bool:
    """Report whether a call is `<something>.name(...)`."""
    return isinstance(node.func, ast.Attribute) and node.func.attr == name


def _guarded_parse_positions(tree: ast.AST) -> set[int]:
    """Return line numbers of `json.loads` calls that sit inside a `try`.

    A parse inside `try` is not automatically safe — it only is when the handler
    discloses what it skipped — but it does not produce the permanent-stall
    behavior, so it is graded lower rather than reported as high.
    """
    guarded: set[int] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Try):
            continue
        for child in ast.walk(node):
            if isinstance(child, ast.Call) and _is_method(child, "loads"):
                guarded.add(getattr(child, "lineno", -1))
            if isinstance(child, ast.Call) and _is_method(child, "read_text"):
                guarded.add(getattr(child, "lineno", -1))
    return guarded


def _reads_input(node: ast.Call) -> bool:
    """Report whether a call reads persisted input that can be corrupt.

    `json.loads`/`read_text`/`open(..., "r")` are the reads whose failure a
    handler can silently paper over. A call to something else — an RPC, a probe,
    a network fetch — is a different failure mode and must not be graded as a
    corrupt-document reset.
    """
    if _is_method(node, "loads") or _is_method(node, "load"):
        return True
    if _is_method(node, "read_text") or _is_method(node, "read_bytes"):
        return True
    mode = _call_mode(node)
    return mode is not None and ("r" in mode or mode == "")


def _discloses_failure(node: ast.Dict) -> bool:
    """Report whether a handler's substituted document discloses the failure.

    A handler that substitutes `{"parse": "失败"}` or `{"message": raw[:200]}`
    records what went wrong and is the honest path, not a silent reset. A reset
    document holds timestamps, parameters, and empty containers instead, so the
    discriminator is a human-readable string literal in the substituted value.

    @param node - The dict literal assigned by the handler.
    @returns True when the value names the failure rather than hiding it.
    """
    for value in node.values:
        if isinstance(value, ast.Constant) and isinstance(value.value, str) and value.value:
            return True
    return False


def _load_repair_tool():
    """载入同目录的修复工具，复用它的契约读取（注册进 `sys.modules` 后再 exec）。

    复用而不是重写：契约的字段、glob 展开与越界判定只有一处实现，审计与修复对
    "什么算这件产物"必须给出一致的答案。
    """
    import importlib.util

    name = "repair_interrupted_run_for_audit"
    if name in sys.modules:
        return sys.modules[name]
    path = Path(__file__).with_name("repair_interrupted_run.py")
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法载入契约读取器：{path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(name, None)
        raise
    return module


def declared_artifacts(contract_path: Path, root: Path) -> set[str]:
    """读运行契约 → 声明的产物相对路径集合（**产物图**）。

    契约把"哪些文件是必须耐久的产物"从猜测变成声明：审计据此提高召回（跨文件的写方
    也能判为耐久产物）并降低噪音（与声明产物无关的 advisory 不再报出）。

    @param contract_path - 契约 JSON 路径。
    @param root - 契约路径的解析根。
    @returns 相对路径集合；越界或格式错误按契约错误抛出。
    """
    tool = _load_repair_tool()
    contract = tool.load_contract(Path(contract_path).resolve(), Path(root).resolve())
    return {artifact.rel for artifact in contract.artifacts}


def file_declared_artifacts(source: str, declared: set[str]) -> set[str]:
    """返回该文件源码里"提到"的声明产物。

    只认**源码文本里的字面量**（相对路径或 basename）：AST 无法解析 `MANIFEST` 常量
    的值，但这类常量通常以路径或文件名形式出现在文件里。刻意不做跨文件变量同名匹配
    ——那会把只是恰好同名的产物混为一谈。

    @param source - 文件源码文本。
    @param declared - 契约声明的产物相对路径集合。
    @returns 该文件提到的声明产物集合（可能为空）。
    """
    hits: set[str] = set()
    for rel in declared:
        name = rel.rsplit("/", 1)[-1]
        if rel in source or (name and name in source):
            hits.add(rel)
    return hits


def audit_source(path: Path, source: str, *,
                 declared_hits: set[str] | None = None
                 ) -> tuple[list[Finding], dict[str, set[str]]]:
    """Audit one Python source file.

    @param path - File path, used for reporting.
    @param source - Decoded source text.
    @returns Per-file findings and the path-usage map the caller aggregates for
        cross-file read/write matching.
    """
    try:
        tree = ast.parse(source)
    except SyntaxError as error:
        return [Finding("UNPARSABLE_SOURCE", ADVISORY, str(path), error.lineno or 1,
                        "", "file could not be parsed, so it was not audited",
                        "none - syntax error")], {}

    lines = source.splitlines()
    at = _line_index(lines)
    guarded = _guarded_parse_positions(tree)
    findings: list[Finding] = []
    usage: dict[str, set[str]] = {}
    declared = bool(declared_hits)
    declared_note = ("（本文件引用了契约声明的产物：" + ", ".join(sorted(declared_hits)) + "）"
                     if declared_hits else "")

    def note(key: str | None, role: str) -> None:
        if key:
            usage.setdefault(key, set()).add(role)

    for node in ast.walk(tree):
        # A whole appended file parsed in one comprehension: one bad line makes
        # every later attempt raise on the same bytes.
        if isinstance(node, ast.ListComp):
            element = node.elt
            parses = (isinstance(element, ast.Call) and _is_method(element, "loads"))
            if parses:
                sources = [gen.iter for gen in node.generators]
                whole_file = any(
                    isinstance(inner, ast.Call) and _is_method(inner, "splitlines")
                    for source_node in sources for inner in ast.walk(source_node))
                if whole_file and element.lineno not in guarded:
                    findings.append(Finding(
                        "UNGUARDED_WHOLE_FILE_PARSE", HIGH, str(path), element.lineno,
                        at(element),
                        "an interrupted line raises here, so every later run fails on"
                        " the same bytes and the artifact never completes",
                        "parse line by line, count the unparsable lines, and return"
                        " that count so the caller can disclose instead of stalling"))
                    for source_node in sources:
                        if isinstance(source_node, ast.Call):
                            note(_path_key(source_node.func.value
                                           if isinstance(source_node.func, ast.Attribute)
                                           else source_node), "read")

        if isinstance(node, ast.Try):
            # `SILENT_RESET_ON_CORRUPT` is specifically "a corrupt *document* was
            # replaced by a fresh empty one". Requiring a persisted-input read in
            # the `try` body is what separates that from a handler that merely
            # defaults a value after an unrelated call failed.
            body = ast.Module(body=node.body, type_ignores=[])
            if not any(isinstance(child, ast.Call) and _reads_input(child)
                       for child in ast.walk(body)):
                continue
            # Names the `try` body touches, Load or Store: the handler usually
            # overwrites the variable the body was in the middle of producing,
            # and that variable is stored in the body, not read there.
            try_names = {child.id for child in ast.walk(body)
                         if isinstance(child, ast.Name)}
            for handler in node.handlers:
                if any(isinstance(child, ast.Raise) for child in ast.walk(handler)):
                    continue          # a re-raising handler discloses the failure
                for child in ast.walk(handler):
                    if (isinstance(child, ast.Assign) and isinstance(child.value, ast.Dict)
                            and isinstance(child.targets[0], ast.Name)
                            and child.targets[0].id in try_names
                            and not _discloses_failure(child.value)):
                        findings.append(Finding(
                            "SILENT_RESET_ON_CORRUPT", HIGH, str(path), child.lineno,
                            at(child),
                            "a corrupt file is replaced by an empty document, so the"
                            " history it held disappears without a word",
                            "fail loud on a corrupt document (quarantine it aside and"
                            " raise) instead of substituting an empty one"))

        if isinstance(node, ast.Call):
            if _is_method(node, "write_text") or _is_method(node, "write_bytes"):
                key = _path_key(node.func.value)
                note(key, "write")
                findings.append(Finding(
                    "NON_ATOMIC_OVERWRITE", ADVISORY, str(path), node.lineno, at(node),
                    "truncates before writing, so a kill leaves a zero-byte or half"
                    " document that existence-only readers accept" + declared_note,
                    "write a temp file in the same directory, then os.replace",
                    key, declared))
            mode = _call_mode(node)
            if mode is not None:
                target = node.args[0] if node.args else None
                key = _path_key(target) if target is not None else None
                if "w" in mode:
                    note(key, "write")
                    findings.append(Finding(
                        "NON_ATOMIC_OVERWRITE", ADVISORY, str(path), node.lineno,
                        at(node),
                        "truncates before writing, so a kill leaves a half file"
                        + declared_note,
                        "write a temp file in the same directory, then os.replace",
                        key, declared))
                elif "a" in mode:
                    note(key, "append")
            if _is_method(node, "exists"):
                findings.append(Finding(
                    "EXISTENCE_ONLY_CHECK", ADVISORY, str(path), node.lineno, at(node),
                    "existence alone cannot distinguish a finished artifact from a"
                    " zero-byte or half-written one",
                    "parse the artifact and require the expected content",
                    _path_key(node.func.value)))
            if _is_method(node, "read_text") and not any(
                    keyword.arg == "errors" for keyword in node.keywords):
                key = _path_key(node.func.value)
                note(key, "read")
                findings.append(Finding(
                    "UNGUARDED_DECODE", ADVISORY, str(path), node.lineno, at(node),
                    "an interrupted multi-byte tail raises here instead of being"
                    " reported as a truncated record",
                    "pass errors='replace' and disclose the replaced characters",
                    key))

    findings.extend(_append_read_cycles(tree, path, at, usage))
    return findings, usage


def _append_read_cycles(tree: ast.AST, path: Path, at, usage: dict[str, set[str]]
                        ) -> list[Finding]:
    """Report read-then-append cycles on one path with no lock in the function."""
    findings: list[Finding] = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        reads: set[str] = set()
        appends: set[str] = set()
        locks = False
        for child in ast.walk(node):
            if isinstance(child, ast.Call):
                called = ""
                if isinstance(child.func, ast.Attribute):
                    called = child.func.attr
                elif isinstance(child.func, ast.Name):
                    called = child.func.id
                if "acquire" in called or "lock" in called.lower():
                    locks = True
                if _is_method(child, "read_text"):
                    key = _path_key(child.func.value)
                    if key:
                        reads.add(key)
                if _is_method(child, "write_text"):
                    continue
                mode = _call_mode(child)
                if mode is not None and "a" in mode and child.args:
                    key = _path_key(child.args[0])
                    if key:
                        appends.add(key)
        for key in sorted(reads & appends):
            if not locks:
                usage.setdefault(key, set()).add("append")
                findings.append(Finding(
                    "UNGUARDED_APPEND_READ", MEDIUM, str(path), node.lineno,
                    f"def {node.name}(...)  # read+append {key} without a lock",
                    "the dedup read and the append are not atomic together, so"
                    " overlapping runs append the same records twice",
                    "hold a single-writer lock across the read and the append"))
    return findings


def classify(findings: list[Finding], usage: dict[str, set[str]]) -> list[Finding]:
    """把"非原子重写"升级为 `medium`——按两种可判定的依据。

    ① 同一文件内读回该路径：写出的半截件会被读方吃下去。
    ② 该文件引用了**契约声明的产物**：这是声明过的耐久产物，与文件内是否读回无关。

    同名匹配一律限定在同一文件内：`OUT` 这类名字在每个脚本里都是不同产物，跨文件
    比较等于把无关文件混为一谈。

    @param findings - 单个文件的原始 findings。
    @param usage - 该文件自己的路径角色表。
    @returns 最终级别的 findings。
    """
    out: list[Finding] = []
    for finding in findings:
        if finding.code != "NON_ATOMIC_OVERWRITE" or finding.severity != ADVISORY:
            out.append(finding)
            continue
        roles = usage.get(finding.key, set()) if finding.key is not None else set()
        read_back = "read" in roles or "append" in roles
        if read_back or finding.declared:
            out.append(Finding(finding.code, MEDIUM, finding.path, finding.line,
                               finding.evidence, finding.why, finding.fix,
                               finding.key, finding.declared))
        else:
            out.append(finding)
    return out


def iter_sources(targets: list[Path]) -> list[Path]:
    """Expand files and directories into a sorted list of Python sources."""
    files: list[Path] = []
    for target in targets:
        if target.is_file() and target.suffix == ".py":
            files.append(target)
            continue
        for candidate in sorted(target.rglob("*.py")):
            if any(part in SKIP_DIRS for part in candidate.parts):
                continue
            files.append(candidate)
    return files


def audit(targets: list[Path], *, contract: Path | None = None,
          root: Path | None = None) -> tuple[list[Finding], int, int]:
    """Audit every Python source under the targets.

    @param targets - Files or directories to scan.
    @param contract - Optional run contract; its artifacts are the **declared**
        durable set, which raises recall (a writer in another file is still a
        durable artifact) and cuts noise (advisories far from any declared
        artifact are suppressed).
    @param root - Root the contract paths resolve against (default: cwd).
    @returns `(findings, files audited, advisories suppressed)`.
    """
    declared = declared_artifacts(contract, root or Path.cwd()) if contract else set()
    all_findings: list[Finding] = []
    suppressed = 0
    files = iter_sources(targets)
    for path in files:
        try:
            source = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as error:
            all_findings.append(Finding("UNAUDITED_FILE", ADVISORY, str(path), 1,
                                        "", f"file could not be read: {error}",
                                        "none - unreadable"))
            continue
        hits = file_declared_artifacts(source, declared) if declared else set()
        findings, file_usage = audit_source(path, source, declared_hits=hits)
        classified = classify(findings, file_usage)
        if declared:
            # 带契约时只关心声明过的耐久产物：与任何声明产物无关的 advisory 属噪音，
            # 抑制并计数（可审计），而不是让它们淹没真正相关的那几条。
            keep = [f for f in classified
                    if f.severity != ADVISORY or f.declared or hits]
            suppressed += len(classified) - len(keep)
            classified = keep
        all_findings.extend(classified)
    order = {HIGH: 0, MEDIUM: 1, ADVISORY: 2}
    all_findings.sort(key=lambda f: (order[f.severity], f.path, f.line))
    return all_findings, len(files), suppressed


def emit(findings: list[Finding], files: int, output_format: str, root: Path, *,
         suppressed: int = 0, declared: int = 0) -> None:
    """Report findings as JSON or as an operator-facing text form."""
    counts = {severity: sum(1 for f in findings if f.severity == severity)
              for severity in (HIGH, MEDIUM, ADVISORY)}
    codes: dict[str, int] = {}
    for finding in findings:
        codes[finding.code] = codes.get(finding.code, 0) + 1
    if output_format == "json":
        print(json.dumps({"files_audited": files, "counts": counts, "codes": codes,
                          "declared_artifacts": declared,
                          "suppressed_advisories": suppressed,
                          "findings": [asdict(f) for f in findings]},
                         ensure_ascii=True, indent=2))
        return
    print(f"audited {files} file(s): high={counts[HIGH]} medium={counts[MEDIUM]}"
          f" advisory={counts[ADVISORY]}"
          + (f"  [contract: {declared} declared artifact(s),"
             f" {suppressed} advisory suppressed]" if declared else ""))
    for finding in findings:
        if finding.severity == ADVISORY:
            continue
        relative = _relative(finding.path, root)
        print(f"  [{finding.severity}] {finding.code} {relative}:{finding.line}")
        print(f"      {finding.evidence}")
        print(f"      why: {finding.why}")
        print(f"      fix: {finding.fix}")
    if counts[ADVISORY]:
        print("  advisory codes: "
              + ", ".join(f"{code}x{n}" for code, n in sorted(codes.items())
                          if code in {"NON_ATOMIC_OVERWRITE", "EXISTENCE_ONLY_CHECK",
                                      "UNGUARDED_DECODE", "UNPARSABLE_SOURCE",
                                      "UNAUDITED_FILE", "UNGUARDED_APPEND_READ"}))
        print("  (run with --format json for every site)")


def _relative(path: str, root: Path) -> str:
    """Return `path` relative to `root` when it is inside it."""
    try:
        return str(Path(path).resolve().relative_to(root.resolve())).replace("\\", "/")
    except (ValueError, OSError):
        return path


# --------------------------------------------------------------------------
# Self-test: each pattern fires on its fixture and stays quiet on its safe twin
# --------------------------------------------------------------------------

FIXTURES = {
    "hazard.py": '''
import json, os
from pathlib import Path
MANIFEST = Path("manifest.json")
DAY = Path("day.jsonl")

def close_day(day_path):
    rows = [json.loads(line) for line in day_path.read_text().splitlines() if line.strip()]
    data = {"days": {}}
    if MANIFEST.exists():
        try:
            data = json.loads(MANIFEST.read_text())
        except ValueError:
            data = {"days": {}}
    MANIFEST.write_text(json.dumps(data))
    return rows

def accumulate(day_path, quotes):
    seen = set()
    if day_path.exists():
        for line in day_path.read_text().splitlines():
            seen.add(json.loads(line)["code"])
    with open(day_path, "a") as f:
        for q in quotes:
            f.write(json.dumps(q) + "\\n")
''',
    "safe.py": '''
import json, os
from pathlib import Path
MANIFEST = Path("manifest.json")

def _write_atomic(path, text):
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text)
    os.replace(tmp, path)

def read_lines(day_path):
    rows, bad = [], []
    for number, line in enumerate(day_path.read_text(errors="replace").splitlines(), 1):
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except ValueError:
            bad.append(number)
    return rows, bad

def close_day(day_path):
    rows, bad = read_lines(day_path)
    data = {"days": {}}
    if MANIFEST.exists():
        try:
            data = json.loads(MANIFEST.read_text(errors="replace"))
        except (OSError, ValueError):
            raise RuntimeError("manifest unreadable; quarantined")
    _write_atomic(MANIFEST, json.dumps(data))
    return rows, bad
''',
    "locked.py": '''
import json
from pathlib import Path

def acquire(path):
    raise RuntimeError

def accumulate(day_path, quotes):
    acquire(day_path)
    seen = set()
    for line in day_path.read_text().splitlines():
        seen.add(json.loads(line)["code"])
    with open(day_path, "a") as f:
        f.write("x")
''',
    "contract_hazard.py": '''
from pathlib import Path
OUT = Path("panel") / "manifest.json"

def save(payload: str):
    OUT.write_text(payload)
''',
}


def selftest() -> int:
    """Assert the hazard fixtures fire and the safe twins stay quiet."""
    with tempfile.TemporaryDirectory(prefix="hazard-audit-") as tmp:
        root = Path(tmp)
        for name, source in FIXTURES.items():
            (root / name).write_text(source.lstrip(), encoding="utf-8")
        findings, files, _ = audit([root])
        codes = {f.code for f in findings}
        hazard_high = {f.code for f in findings
                       if f.severity == HIGH and f.path.endswith("hazard.py")}
        hazard_medium = {f.code for f in findings
                         if f.severity == MEDIUM and f.path.endswith("hazard.py")}
        safe_findings = [f for f in findings
                         if f.path.endswith("safe.py") and f.severity in (HIGH, MEDIUM)]
        locked_medium = [f for f in findings if f.path.endswith("locked.py")
                         and f.severity == MEDIUM]
        checks = [
            ("high patterns fire on the hazard fixture",
             hazard_high == {"UNGUARDED_WHOLE_FILE_PARSE", "SILENT_RESET_ON_CORRUPT"},
             f"high={sorted(hazard_high)}"),
            ("overwrite escalates to medium when read back",
             "NON_ATOMIC_OVERWRITE" in hazard_medium and "UNGUARDED_APPEND_READ" in hazard_medium,
             f"medium={sorted(hazard_medium)}"),
            ("advisory patterns present",
             {"EXISTENCE_ONLY_CHECK", "UNGUARDED_DECODE"} <= codes,
             f"codes={sorted(codes)}"),
            ("safe twin has no high or medium finding",
             not safe_findings,
             f"safe={[f.code for f in safe_findings]}"),
            ("a lock in the enclosing function clears the append cycle",
             not locked_medium,
             f"locked={[f.code for f in locked_medium]}"),
            ("every audited file was counted", files == 4, f"files={files}"),
        ]

        # 契约模式：声明产物 ⇒ 跨文件的写方也升级为 medium；无关 advisory 被抑制
        contract = root / "contract.json"
        contract.write_text(json.dumps({
            "run": "selftest",
            "artifacts": [{"path": "panel/manifest.json", "kind": "json"}],
        }), encoding="utf-8")
        plain_medium = [f for f in findings if f.code == "NON_ATOMIC_OVERWRITE"
                        and f.severity == MEDIUM and f.path.endswith("contract_hazard.py")]
        declared_findings, _, suppressed = audit([root], contract=contract, root=root)
        escalated = [f for f in declared_findings if f.code == "NON_ATOMIC_OVERWRITE"
                     and f.severity == MEDIUM and f.declared
                     and f.path.endswith("contract_hazard.py")]
        locked_advisories = [f for f in declared_findings
                             if f.path.endswith("locked.py") and f.severity == ADVISORY]
        checks.append(("contract escalates a declared-artifact writer",
                       not plain_medium and bool(escalated),
                       f"plain={len(plain_medium)} declared={len(escalated)}"))
        checks.append(("contract suppresses advisories far from any declared artifact",
                       suppressed > 0 and not locked_advisories,
                       f"suppressed={suppressed} locked_advisories={len(locked_advisories)}"))

        # 空扫描必须响：目录改名/路径打错时，"0 file(s)" 曾经是一份永久的绿色结论
        def quiet(*argv: str) -> int:
            with contextlib.redirect_stdout(io.StringIO()), \
                    contextlib.redirect_stderr(io.StringIO()):
                return main(list(argv))

        empty = root / "empty"
        empty.mkdir(exist_ok=True)
        absent = str(root / "renamed-away")
        checks.append(("a missing target fails loud instead of auditing nothing",
                       quiet(absent, "--allow-empty") == 2, f"rc={quiet(absent, '--allow-empty')}"))
        checks.append(("an empty scan fails loud unless --allow-empty is asked for",
                       quiet(str(empty)) == 2 and quiet(str(empty), "--allow-empty") == 0,
                       f"strict={quiet(str(empty))} allowed={quiet(str(empty), '--allow-empty')}"))
    failures = 0
    print("audit_interruption_hazards selftest")
    for name, ok, detail in checks:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}: {detail}")
        failures += 0 if ok else 1
    print(f"  {len(checks) - failures}/{len(checks)} check(s) passed")
    return 1 if failures else 0


def main(argv: list[str] | None = None) -> int:
    """Parse arguments and audit the requested targets."""
    parser = argparse.ArgumentParser(
        prog="audit_interruption_hazards.py",
        description="Static audit for code that turns an interruption into permanent damage.")
    parser.add_argument("targets", nargs="*", help="files or directories to scan")
    parser.add_argument("--format", choices=("text", "json"), default="text")
    parser.add_argument("--root", help="root used to shorten reported paths")
    parser.add_argument("--contract",
                        help="run contract JSON whose artifacts are the declared"
                             " durable set (raises recall, cuts advisory noise)")
    parser.add_argument("--allow-empty", action="store_true",
                        help="accept a run that scanned no file; without it an empty"
                             " scan fails loud, because a mistyped or renamed target"
                             " would otherwise report clean forever")
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args(argv)
    _ascii_safe()
    if args.selftest:
        return selftest()
    if not args.targets:
        parser.error("at least one target is required")
    targets = [Path(target) for target in args.targets]
    absent = [str(target) for target in targets if not target.exists()]
    if absent:
        print(f"audit failed: target not found: {', '.join(absent)}", file=sys.stderr)
        return 2
    root = Path(args.root) if args.root else Path.cwd()
    try:
        findings, files, suppressed = audit(targets, contract=Path(args.contract)
                                            if args.contract else None, root=root)
    except Exception as error:  # noqa: BLE001 —— 契约错误属用法问题，退出码 2
        print(f"audit failed: {type(error).__name__}: {error}", file=sys.stderr)
        return 2
    if files == 0 and not args.allow_empty:
        print("audit failed: no Python file scanned; targets exist but hold none."
              " Pass --allow-empty to accept this run.", file=sys.stderr)
        return 2
    declared = len(declared_artifacts(Path(args.contract), root)) if args.contract else 0
    emit(findings, files, args.format, root, suppressed=suppressed, declared=declared)
    return 1 if any(f.severity in (HIGH, MEDIUM) for f in findings) else 0


if __name__ == "__main__":
    raise SystemExit(main())
