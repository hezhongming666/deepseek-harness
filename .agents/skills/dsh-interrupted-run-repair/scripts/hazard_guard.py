#!/usr/bin/env python3
"""中断危害**回归门禁**：只对"新出现"的危害报警。

全仓审计一次就是几十条；每天都把同一批重报一遍等于没有信号。本门禁持有基线快照，
只对**新增**项报警，把信号留给"新写下的危害"，而不是"已知的旧账"。

身份 = `形态 + 相对路径 + 归一化证据行 + 出现序号`：
- **不含行号**——行号随无关改动漂移，算进身份会让每次编辑都刷出一批假"新增"；
- 带出现序号——同一文件里两处**一模一样**的危害仍可分辨，新加第三处会被看见。

通知与阈值都由调用方给：门禁本身不绑定任何告警通道（`--notify-cmd` 收到告警正文的
stdin 与环境变量 `HAZARD_GUARD_SUMMARY`），退出码也可由调用方钉住
（`--exit-code-new`，便于接入既有调度约定）。

用法：
    python3 scripts/hazard_guard.py --roots scripts,quantframe --root . --baseline base.json
    python3 scripts/hazard_guard.py --roots . --update-baseline     # 人类动作：接受现状
    python3 scripts/hazard_guard.py --roots . --contract run.json --min-severity high \\
        --notify-cmd "python notify.py" --exit-code-new 6
    python3 scripts/hazard_guard.py --selftest

退出码：0 = 无新增；`--exit-code-new`（默认 1）= 有新增；2 = 用法/IO 错误，或扫描
到 0 个 Python 文件（目标目录改名、路径写错都会走到这里；`--allow-empty` 才接受空扫描，
`--update-baseline` 在空扫描下不写文件——否则等于把基线连判据一起清掉）。
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import contextlib
import io
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
AUDITOR = HERE / "audit_interruption_hazards.py"
SEVERITY_ORDER = {"high": 0, "medium": 1, "advisory": 2}
DEFAULT_NOTIFY_TIMEOUT = 60.0


def write_text_atomic(path: Path, text: str) -> None:
    """整文件原子替换（同目录临时文件 + `os.replace`）。

    **基线自身也必须原子落盘**：被中断写坏的基线会让下一次运行把整个代码库判成
    "全部新增"，门禁反而成了告警风暴的源头。工具侧只保留这一个最小实现——被审计
    项目自己的 `durable_io` 属于那个项目，本技能不依赖它。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def _ascii_safe() -> None:
    """控制台输出降级为当前编码可表示的字符。

    被扫到的源码里可能有中文注释或路径（GBK 控制台编码不了），若让 `print` 直接抛
    `UnicodeEncodeError`，工具会因为在**报告**一个中文项目而崩掉。告警正文走
    `--notify-cmd` 的 stdin，是完整 UTF-8，不受此处影响。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError, OSError):
            pass


def _load_auditor():
    """载入同目录审计器（注册进 `sys.modules` 后再 exec，否则 3.12 的 dataclass 会炸）。"""
    name = "audit_interruption_hazards_for_guard"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, AUDITOR)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法载入审计器：{AUDITOR}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(name, None)
        raise
    return module


def scan(roots: list[Path], contract: Path | None, root: Path) -> tuple[list[dict], int, int]:
    """跑一次审计 → `(findings, 文件数, 被抑制的 advisory 数)`。"""
    auditor = _load_auditor()
    findings, files, suppressed = auditor.audit(roots, contract=contract, root=root)
    return [auditor.asdict(f) for f in findings], files, suppressed


def _relative(path: str, root: Path) -> str:
    """把绝对路径折算为相对 root 的形式（用于身份与展示）。"""
    try:
        return str(Path(path).resolve().relative_to(root.resolve())).replace("\\", "/")
    except (ValueError, OSError):
        return path.replace("\\", "/")


def base_identity(finding: dict, root: Path) -> str:
    """返回不含行号的基础身份：形态 + 级别 + 相对路径 + 归一化证据行。

    **级别进身份**：同一处代码从 advisory 升到 medium（例如加了契约、把某个文件
    认定为声明产物）是"变差了"，必须报出来；只按形态+路径判身份会把它吞掉。
    """
    evidence = re.sub(r"\s+", " ", finding.get("evidence") or "").strip()
    return f"{finding['code']}|{finding['severity']}|{_relative(finding['path'], root)}|{evidence}"


def identities_for(findings: list[dict], root: Path) -> dict[str, dict]:
    """身份 → finding，并给同文件内的相同证据行加出现序号。

    @param findings - 审计结果。
    @param root - 用于折算相对路径。
    @returns 身份到 finding 的映射，键形如 `<基础身份>#<序号>`。
    """
    counter: dict[str, int] = {}
    out: dict[str, dict] = {}
    for finding in sorted(findings, key=lambda f: (f["path"], f["line"])):
        base = base_identity(finding, root)
        index = counter.get(base, 0)
        counter[base] = index + 1
        out[f"{base}#{index}"] = finding
    return out


def compare(current: list[dict], baseline: dict, root: Path, *,
            min_severity: str) -> tuple[list[dict], list[str], int]:
    """→ (新增且达阈值的 findings, 消失的身份, 基线内已有的条数)。"""
    baseline_ids = set(baseline.get("identities", []))
    current_ids = identities_for(current, root)
    new_ids = [key for key in current_ids if key not in baseline_ids]
    gone = [key for key in baseline_ids if key not in current_ids]
    known = len(current_ids) - len(new_ids)
    limit = SEVERITY_ORDER[min_severity]
    new = [current_ids[key] for key in new_ids
           if SEVERITY_ORDER[current_ids[key]["severity"]] <= limit]
    return new, sorted(gone), known


def alert_body(new: list[dict], gone: list[str], known: int, files: int,
               root: Path) -> str:
    """构造告警正文（调用方决定发到哪里）。"""
    lines = [f"中断危害回归：新增 {len(new)} 项（**未自动改动**）",
             f"本次审计 {files} 个文件；基线与本次共有 {known} 项"]
    for finding in new:
        lines.append(f"- [{finding['severity']}] {finding['code']} "
                     f"{_relative(finding['path'], root)}:{finding['line']}")
        lines.append(f"    {finding['evidence']}")
        lines.append(f"    修法：{finding['fix']}")
    if gone:
        lines.append(f"另有 {len(gone)} 项已从基线消失（多半是有人修了）")
    return "\n".join(lines)


def notify(command: str, body: str, summary: str, timeout: float) -> str:
    """把告警正文交给调用方给定的命令（正文走 stdin，摘要走环境变量）。

    推送失败只记结果、不改判定：门禁的结论由代码决定，不该由一个通知通道决定。

    @param command - 由调用方提供的命令行。
    @param body - 告警正文，写到子进程 stdin。
    @param summary - 一行摘要，放进 `HAZARD_GUARD_SUMMARY`。
    @param timeout - 秒；超时按失败处理。
    @returns `sent` / `failed:<原因>`。
    """
    environment = dict(os.environ, HAZARD_GUARD_SUMMARY=summary)
    try:
        done = subprocess.run(command, shell=True, input=body, text=True,
                              capture_output=True, env=environment, timeout=timeout)
    except subprocess.TimeoutExpired:
        return "failed:timeout"
    except OSError as error:
        return f"failed:{type(error).__name__}"
    if done.returncode != 0:
        return f"failed:rc={done.returncode}"
    return "sent"


def run(*, roots: list[Path], root: Path, contract: Path | None, baseline_path: Path,
        update_baseline: bool, min_severity: str, notify_cmd: str | None,
        notify_timeout: float, report_path: Path | None, exit_code_new: int,
        output_format: str, allow_empty: bool = False) -> int:
    """执行一次回归门禁并返回退出码。"""
    findings, files, suppressed = scan(roots, contract, root)
    counts = {severity: sum(1 for f in findings if f["severity"] == severity)
              for severity in SEVERITY_ORDER}

    # 空扫描是"绿得可疑"，不是干净：目标目录改名或路径写错时，报 clean 会让门禁
    # 永久失效；--update-baseline 更会把基线清空，等于把历史判据一起删掉。
    if files == 0 and not allow_empty:
        print("hazard guard failed: no Python file scanned under "
              f"{', '.join(str(r) for r in roots)}; fix the target paths or pass"
              " --allow-empty if an empty scan is really intended", file=sys.stderr)
        return 2

    if update_baseline:
        baseline_path.parent.mkdir(parents=True, exist_ok=True)
        write_text_atomic(baseline_path, json.dumps({
            "updated_at": datetime.now().isoformat(timespec="seconds"),
            "roots": [str(r) for r in roots],
            "contract": str(contract) if contract else None,
            "counts": {"total": len(findings), **counts},
            "note": "身份不含行号；由 hazard_guard.py --update-baseline 写入",
            "identities": sorted(identities_for(findings, root)),
        }, ensure_ascii=False, indent=1))
        payload = {"verdict": "baseline-updated", "files_audited": files,
                   "counts": counts, "suppressed_advisories": suppressed,
                   "baseline": str(baseline_path)}
        _emit(payload, [], [], output_format, root)
        return 0

    baseline = (json.loads(baseline_path.read_text(encoding="utf-8"))
                if baseline_path.exists() else {"identities": []})
    new, gone, known = compare(findings, baseline, root, min_severity=min_severity)
    summary = (f"files={files} known={known} new={len(new)}"
               f" min_severity={min_severity} resolved={len(gone)}"
               f" baseline={'yes' if baseline_path.exists() else 'no'}")
    body = alert_body(new, gone, known, files, root) if new else ""
    delivery = notify(notify_cmd, body, summary, notify_timeout) if (new and notify_cmd) else None
    payload = {"verdict": "new-hazards" if new else "clean", "files_audited": files,
               "known": known, "resolved": len(gone), "counts": counts,
               "suppressed_advisories": suppressed, "min_severity": min_severity,
               "notify": delivery, "baseline": str(baseline_path)}
    _emit(payload, new, gone, output_format, root)
    if report_path is not None:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps({**payload, "new": new, "resolved": gone},
                                          ensure_ascii=False, indent=1),
                               encoding="utf-8")
    return exit_code_new if new else 0


def _emit(payload: dict, new: list[dict], gone: list[str], output_format: str,
          root: Path) -> None:
    """输出人类可读摘要或机器可读报告。"""
    if output_format == "json":
        print(json.dumps({**payload, "new": new, "resolved": gone},
                         ensure_ascii=True, indent=2))
        return
    counts = payload["counts"]
    print(f"hazard guard: {payload['verdict']} files={payload['files_audited']}"
          f" high={counts['high']} medium={counts['medium']} advisory={counts['advisory']}"
          + (f" known={payload['known']} resolved={payload['resolved']}"
             if "known" in payload else "")
          + (f" suppressed={payload['suppressed_advisories']}"
             if payload.get("suppressed_advisories") else "")
          + (f" notify={payload['notify']}" if payload.get("notify") else ""))
    for finding in new:
        print(f"  [new:{finding['severity']}] {finding['code']} "
              f"{_relative(finding['path'], root)}:{finding['line']}")
        print(f"      {finding['evidence']}")
        print(f"      fix: {finding['fix']}")


# --------------------------------------------------------------------------
# Self-test: the guard's own contract, on fixtures
# --------------------------------------------------------------------------

GUARD_FIXTURE = '''
import json
from pathlib import Path
DAY = Path("day.jsonl")

def load(day_path):
    return [json.loads(line) for line in day_path.read_text().splitlines() if line.strip()]

def append(day_path, rows):
    seen = load(day_path)
    with open(day_path, "a") as f:
        for row in rows:
            f.write(json.dumps(row) + "\\n")
'''

SAFE_FIXTURE = '''
import json
import os
from pathlib import Path

def write_atomic(path, text):
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text)
    os.replace(tmp, path)

def load(day_path):
    rows, bad = [], []
    for number, line in enumerate(day_path.read_text(errors="replace").splitlines(), 1):
        try:
            rows.append(json.loads(line))
        except ValueError:
            bad.append(number)
    return rows, bad
'''


def selftest() -> int:
    """断言门禁的三条主路径与两条身份边界。"""
    checks: list[tuple[str, bool, str]] = []
    with tempfile.TemporaryDirectory(prefix="hazard-guard-") as tmp:
        root = Path(tmp)
        src = root / "src"
        src.mkdir()
        (src / "old.py").write_text(GUARD_FIXTURE.lstrip(), encoding="utf-8")
        (src / "safe.py").write_text(SAFE_FIXTURE.lstrip(), encoding="utf-8")
        baseline = root / "baseline.json"
        notifier_out = root / "notified.txt"
        notify_cmd = (f'"{sys.executable}" -c '
                      f'"import pathlib,sys; pathlib.Path(r\'{notifier_out}\')'
                      f'.write_text(sys.stdin.read(), encoding=\'utf-8\')"')

        def call(**kwargs) -> int:
            options = dict(roots=[src], root=root, contract=None, baseline_path=baseline,
                           update_baseline=False, min_severity="medium",
                           notify_cmd=None, notify_timeout=DEFAULT_NOTIFY_TIMEOUT,
                           report_path=None, exit_code_new=6, output_format="text")
            options.update(kwargs)
            return run(**options)

        code = call(update_baseline=True)
        checks.append(("update-baseline writes the baseline and exits 0",
                       code == 0 and baseline.exists()
                       and json.loads(baseline.read_text(encoding="utf-8"))["identities"],
                       f"rc={code}"))

        code = call()
        checks.append(("known hazards stay quiet (no notify)",
                       code == 0 and not notifier_out.exists(), f"rc={code}"))

        (src / "new.py").write_text(GUARD_FIXTURE.lstrip().replace("day.jsonl", "other.jsonl"),
                                    encoding="utf-8")
        code = call(notify_cmd=notify_cmd)
        body = notifier_out.read_text(encoding="utf-8") if notifier_out.exists() else ""
        checks.append(("new hazard -> caller's exit code + alert on stdin",
                       code == 6 and "new.py" in body and "UNGUARDED_WHOLE_FILE_PARSE" in body,
                       f"rc={code} body={len(body)}B"))

        (src / "new.py").unlink()
        notifier_out.unlink(missing_ok=True)
        checks.append(("resolved hazard exits 0", call() == 0, "rc"))

        (src / "old.py").write_text("\n\n\n" + GUARD_FIXTURE.lstrip(), encoding="utf-8")
        checks.append(("line shift is not a new hazard", call() == 0, "rc"))

        (src / "old.py").write_text(
            "\n\n\n" + GUARD_FIXTURE.lstrip() + "\n" + GUARD_FIXTURE.lstrip(),
            encoding="utf-8")
        notifier_out.unlink(missing_ok=True)
        checks.append(("added duplicate hazard still alarms", call() == 6, "rc"))

        # 阈值：只报 high 时，新增的 medium 不应触发
        (src / "old.py").write_text("\n\n\n" + GUARD_FIXTURE.lstrip(), encoding="utf-8")
        (src / "medium_new.py").write_text(
            'from pathlib import Path\n\nOUT = Path("panel") / "x.json"\n\n'
            'def save(p):\n    OUT.write_text(p)\n    return OUT.read_text()\n',
            encoding="utf-8")
        high_only = call(min_severity="high")
        medium_too = call(min_severity="medium")
        checks.append(("severity threshold is honoured",
                       high_only == 0 and medium_too == 6,
                       f"high-only={high_only} medium={medium_too}"))

        # 契约：声明产物 ⇒ 跨文件写方升级为 medium（级别变化本身就是"变差"，须报）
        contract = root / "contract.json"
        contract.write_text(json.dumps({
            "run": "selftest",
            "artifacts": [{"path": "panel/manifest.json", "kind": "json"}],
        }), encoding="utf-8")
        (src / "medium_new.py").unlink()          # 清掉上一步留下的 medium 危害
        declared_baseline = root / "declared_baseline.json"
        call(baseline_path=declared_baseline, update_baseline=True)
        (src / "declared.py").write_text(
            'from pathlib import Path\n\nOUT = Path("panel") / "manifest.json"\n\n'
            'def save(p):\n    OUT.write_text(p)\n',
            encoding="utf-8")
        call(baseline_path=declared_baseline, update_baseline=True)   # 先按 advisory 记入基线
        plain = call(baseline_path=declared_baseline, min_severity="medium")
        with_contract = call(baseline_path=declared_baseline, min_severity="medium",
                             contract=contract)
        checks.append(("severity escalation to a declared artifact is reported",
                       plain == 0 and with_contract == 6,
                       f"plain={plain} contract={with_contract}"))

        # 空扫描：目标改名/路径写错时，"clean" 会让这道门禁永久失效；
        # --update-baseline 更危险——它会把基线清空，等于删掉判据。
        empty = root / "empty"
        empty.mkdir()
        empty_baseline = root / "empty_baseline.json"
        with contextlib.redirect_stderr(io.StringIO()):
            strict = call(roots=[empty], baseline_path=empty_baseline)
            recorded = call(roots=[empty], baseline_path=empty_baseline,
                            update_baseline=True)
            allowed = call(roots=[empty], baseline_path=empty_baseline, allow_empty=True)
        checks.append(("an empty scan fails loud and never records an empty baseline",
                       strict == 2 and recorded == 2 and not empty_baseline.exists()
                       and allowed == 0,
                       f"strict={strict} update={recorded} allowed={allowed}"
                       f" baseline={empty_baseline.exists()}"))

    failures = 0
    print("hazard_guard selftest")
    for name, ok, detail in checks:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}: {detail}")
        failures += 0 if ok else 1
    print(f"  {len(checks) - failures}/{len(checks)} check(s) passed")
    return 1 if failures else 0


def main(argv: list[str] | None = None) -> int:
    """Parse arguments and run the guard once, or its self-test."""
    parser = argparse.ArgumentParser(
        prog="hazard_guard.py",
        description="Alarm only on hazards that are NEW since the baseline.")
    parser.add_argument("--roots", default=".",
                        help="comma-separated directories or files to scan")
    parser.add_argument("--root", default=".", help="root for relative paths and the contract")
    parser.add_argument("--contract", help="run contract JSON (declared durable artifacts)")
    parser.add_argument("--baseline", required=False, help="baseline snapshot JSON")
    parser.add_argument("--update-baseline", action="store_true",
                        help="accept the current state as the new baseline (a human act)")
    parser.add_argument("--min-severity", choices=tuple(SEVERITY_ORDER), default="medium",
                        help="lowest severity that triggers an alert (default: medium)")
    parser.add_argument("--notify-cmd", help="command run with the alert body on stdin")
    parser.add_argument("--notify-timeout", type=float, default=DEFAULT_NOTIFY_TIMEOUT)
    parser.add_argument("--report", help="also write the JSON report to this path")
    parser.add_argument("--exit-code-new", type=int, default=1,
                        help="exit code when new hazards are found (default: 1)")
    parser.add_argument("--format", choices=("text", "json"), default="text")
    parser.add_argument("--allow-empty", action="store_true",
                        help="accept a scan that reaches no Python file (default: fail loud)")
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args(argv)
    _ascii_safe()
    if args.selftest:
        return selftest()
    if not args.baseline:
        parser.error("--baseline is required (or pass --selftest)")
    root = Path(args.root).resolve()
    roots = [Path(name) if Path(name).is_absolute() else root / name
             for name in args.roots.split(",") if name.strip()]
    try:
        return run(roots=roots, root=root,
                   contract=Path(args.contract).resolve() if args.contract else None,
                   baseline_path=Path(args.baseline).resolve(),
                   update_baseline=args.update_baseline,
                   min_severity=args.min_severity, notify_cmd=args.notify_cmd,
                   notify_timeout=args.notify_timeout,
                   report_path=Path(args.report).resolve() if args.report else None,
                   exit_code_new=args.exit_code_new, output_format=args.format,
                   allow_empty=args.allow_empty)
    except Exception as error:  # noqa: BLE001 —— 用法/IO 错误退出码 2
        print(f"hazard guard failed: {type(error).__name__}: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
