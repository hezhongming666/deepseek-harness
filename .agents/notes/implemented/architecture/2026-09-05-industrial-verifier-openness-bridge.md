# Agent Note: TIA Portal compile as a verifier over the Openness bridge

Status: implemented

English | [中文](2026-09-05-industrial-verifier-openness-bridge.zh.md)

## Problem

The industrial family shipped local deterministic validators (`st-syntax`/`st-lint`) but no real vendor compile, so a control program could pass the stage while TIA Portal itself would reject it. The Openness bridge (`packages/spec-loop/provider-openness`) already serves a real TIA Portal compile through its `/run` verify action, but the spec-loop adapter seam is a parameter-search loop — it cannot feed adjudication reports into the verifier registry the orchestrator binds stages to.

## Decision

**A new `industrial/ia-verifier-openness` package registers the `tia-compile` kind into `ctx.iaVerifiers`.** The kind imports the submitted TIA SCL block into the configured TIA project through the bridge's `/run` verify action and compiles it; the report carries TIA Portal's own error/warning counts and messages. The local checks stay the fallback: the conveyor-line template lists `tia-compile` in a new `optionalVerifiers` slot, so it runs only when the kind is registered — `st-syntax`/`st-lint` always run.

**Fail-closed everywhere.** An unreachable bridge, a timeout, an infrastructure or killed run, and a malformed wire body all yield `pass: false` with a `tia-compile-unavailable` diagnostic; a block the bridge cannot import yields `tia-compile-import-failed`; empty submissions are answered locally (`tia-compile-empty-input`) without a round-trip, which also keeps the registry's empty-input invariant probe offline. The `url` is required and fails at load, so the package is mounted per deployment (profile patch or the `cordis.openness.yml` overlay), never inside the `dsh-ia` bundle.

**Per-message severity on the wire.** TIA's `CompilerResultMessage.State` (`CompilerResultState`) is flattened into a `compileMessageStates` array parallel to `compileMessages`; the TypeScript parser falls back to count-prefix attribution (first `compileErrors` messages are errors) for older bridges. The fake bridge emits the same field, so both channels share one wire contract over the one physical bridge.

**One submission, two explicit sources.** The two dialects share no text — the local checks parse the harness `PROGRAM` subset, TIA SCL uses `FUNCTION`/`FUNCTION_BLOCK`. `VerificationInput` and `Submission` therefore carry an optional `vendorSource`: local kinds read `text`, `tia-compile` reads `vendorSource` and falls back to `text`. This is an explicit second source, not a translator — no code rewrites either dialect into the other, and a submission that omits `vendorSource` still compiles as-is through a direct `ia_verify` call. The submitted TIA SCL block must be named exactly after the configured `blockName`.

## Alternatives considered

- **A spec-loop adapter instead** — the seam's validate/run outcomes are loop-iteration vocabulary, not adjudication reports; the orchestrator would have to import spec-loop machinery to bind one stage verifier.
- **Bundling the package in `dsh-ia`** — the required `url` would break every deployment without a bridge at load; a silent no-op default would violate fail-loud misconfiguration and trap stages in a permanently-unavailable optional verifier.
- **Extending `ia-verifier` with the bridge client** — couples the registry package to one vendor and drags network I/O into the load path of every local-only deployment.
- **A dialect translator in the adapter** — rewriting the harness `PROGRAM` text into TIA SCL (or vice versa) would hide one source of truth behind a lossy transform and let what the vendor compiled diverge from what the local checks saw; an explicit second source keeps both artifacts honest.
- **A severity-less wire** — reusing the existing compile result would force the verifier to guess per-message severity from counts; emitting `compileMessageStates` keeps adjudication evidence exact, with the fallback for older bridges.

## Consequences

Bought: the closed loop's §2.3 "真实编译裁决" exists end to end — registry kind, optional stage binding, the `vendorSource` second-source seam, fail-closed reports, and a proven live channel against TIA Portal V21: a control-program submission carrying both dialects passes with all three reports green, and one whose TIA SCL names an undefined tag fails with the compiler's own message. Local fallback stays intact when no bridge is mounted.

Cost: one more package to mount per deployment; the bridge compiles the whole PLC software, so any other broken block in the scratch project fails every verification and the named block is overwritten on each run; a verify round-trip runs to the bridge timeout with no caller-facing cancel seam.
