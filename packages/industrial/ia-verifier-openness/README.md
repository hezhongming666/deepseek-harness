# @deepseek-ai/dsh-ia-verifier-openness

English | [中文](README.zh.md)

The real-vendor compile channel of the industrial closed loop: registers the `tia-compile` validator kind into `ctx.iaVerifiers`. Every verification bound to the kind imports the submitted TIA SCL block into the configured TIA project through the Openness bridge and compiles it — the report carries TIA Portal's own error/warning counts and messages, so a passing verdict means the vendor compiler accepted the block, not that a local stand-in parsed it. Local checks stay the fallback: the conveyor-line template runs `st-syntax`/`st-lint` always, and adds `tia-compile` only when this plugin is mounted.

## Configuration

| key | meaning |
|---|---|
| `url` | Absolute http(s) URL of the running Openness bridge, e.g. `http://127.0.0.1:4281` (required — loading without it fails). |
| `blockName` | The TIA block name the submitted source is imported as; default `IACheck`. Must be a TIA identifier (letter or underscore, then letters, digits, underscores; at most 128 characters). |
| `requestTimeoutMs` | Per-request bridge timeout in milliseconds; default 300000. |

## The `tia-compile` kind

| field | value |
|---|---|
| kind | `tia-compile` |
| input | TIA SCL source text: a `FUNCTION` or `FUNCTION_BLOCK` definition with `{ S7_Optimized_Access := 'TRUE' }`, `VERSION`, `VAR_*` blocks, and `BEGIN ... END_FUNCTION` — not the `PROGRAM` dialect the built-in ST checks parse. Read from `vendorSource` when present, else from `text`, so one submission can carry both dialects. The source must declare a block named exactly after the configured `blockName`. |
| verdict | `pass` is true exactly when the compiler reports zero errors; warnings stay advisory diagnostics. |

Report diagnostics: `tia-compile-error` and `tia-compile-warning` carry the compiler's error and warning messages (informational compiler lines are dropped); `tia-compile-import-failed` names a block the bridge could not import; `tia-compile-unavailable` covers an unreachable bridge, a timeout, an infrastructure or killed run, and malformed wire responses; `tia-compile-empty-input` is answered locally without a bridge round-trip. All four failure paths are fail-closed — `pass` stays false, so the submission never slips through on a broken channel.

## Model Experience

Indirectly, through dsh-tool-ia's `ia_verify` and `ia_project` tools, which render these reports and stage verdicts.

#### KV Cache effect

Independent. The plugin registers no prompt or tool schema and keeps no request-scoped state; report text enters requests only as tool results.

## Known Limitations and Deferred Work

- **One bridge per mount** — the verifier targets a single `url`, so one mount compiles against one TIA project; multi-project sites mount the plugin once per project profile.
- **Whole-software compile** — the bridge compiles the entire PLC software, so any other broken block in the scratch project fails every verification; keep the scratch project clean, and expect the named block to be overwritten on every verify.
- **No cancellation seam** — a verify round-trip runs to the bridge timeout; the spec-loop adapter's `/cancel` path is not wired here because verification has no caller-facing cancel contract.
