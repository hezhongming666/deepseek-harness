# @deepseek-ai/dsh-ia-verifier

English | [中文](README.zh.md)

The deterministic adjudication layer of the industrial closed loop: a registry of named validators whose verdicts are pure functions of the input — no model calls, no clock or environment reads, so the same artifact always yields the same report. This is the "系统裁决" half of the architecture's 模型生成、系统裁决、人类把关.

## Configuration

| key | meaning |
|---|---|
| `builtins` | Built-in validator kinds to activate at load; default `[st-syntax, st-lint, io-consistency]`. An unknown entry fails at load. |

## Service API

`ctx.iaVerifiers`:

- `register(descriptor)` — register one named validator; returns the removal disposer. Duplicate kinds throw `DuplicateVerifierError`.
- `kinds()` — registered kinds in registration order.
- `get(kind)` — the descriptor, or `undefined`.
- `verify(kind, input)` — run one check; unregistered kinds throw `UnknownVerifierError` (verification never silently skips).
- `verifyAll(kinds, input)` — run several checks over one input in order.

A `VerificationReport` is `{ kind, pass, diagnostics, evidence }`; `pass` is false exactly when a diagnostic carries severity `'error'`. The invariant companion proves that consistency for every registered validator on an empty-input probe.

## Built-in validators

| kind | Input | What it checks |
|---|---|---|
| `st-syntax` | IEC 61131-3 Structured Text source | Deterministic lexer + recursive-descent parser for the documented ST subset; reports every lexical and syntactic problem with a one-based line/column position. |
| `st-lint` | Structured Text source | Name resolution and hygiene: undefined references (errors), duplicate declarations (errors), unknown named types (errors), loop control outside loops (errors), unused variables (warnings). |
| `io-consistency` | JSON document `{ "io": [{ "tag", "address" }], "symbols": [{ "name" }] }` | Two-way IO-list ↔ symbol-table consistency: duplicate tags/addresses/names and missing symbols are errors, orphan symbols are warnings. |

The supported ST subset covers `PROGRAM`/`FUNCTION_BLOCK` with `VAR` blocks, `AT` addresses, elementary/array/named types, assignments, calls, `IF/ELSIF/ELSE`, `CASE` with multi-label arms, `FOR/WHILE/REPEAT` loops, `EXIT/CONTINUE/RETURN`, full expression precedence including `**` and `NOT`, array indexing, nested `(* *)` comments, and `''` string escapes. Vendor-specific syntax beyond the subset is reported, never silently accepted — the design's 宁可人工也不可假自动.

Extension providers register further kinds; the shipped `@deepseek-ai/dsh-ia-verifier-openness` registers `tia-compile`, which adjudicates TIA SCL source through a real TIA Portal compile over the Openness bridge.

## Model Experience

Indirectly, through dsh-tool-ia's `ia_verify` tool, which is the only model-facing surface that renders these reports.

#### KV Cache effect

Independent. The registry keeps no request-scoped state and registers no prompt or tool schema; report text enters requests only as `ia_verify` tool results.

## Known Limitations and Deferred Work

- **No local vendor compiler** — `st-syntax` is a local stand-in, not a TIA/CODESYS compile; the sibling package `@deepseek-ai/dsh-ia-verifier-openness` binds the real TIA Portal compile as the additional `tia-compile` kind through the Openness bridge.
- **One-text submission model with a vendor seam** — `verifyAll` feeds the same input to every bound kind: local kinds read `text`, while external compile kinds (e.g. `tia-compile`) read the optional `vendorSource` and fall back to `text`. One submission can therefore carry both the harness `PROGRAM` dialect for the local checks and the TIA SCL block for the real vendor compile; the io-consistency check still runs standalone through `ia_verify`.
- **The ST subset is closed** — `FUNCTION` POUs, `VAR_GLOBAL/RETAIN`, struct types, method calls, and pointer/dereference syntax are not parsed; sources using them fail loudly instead of being guessed at.
