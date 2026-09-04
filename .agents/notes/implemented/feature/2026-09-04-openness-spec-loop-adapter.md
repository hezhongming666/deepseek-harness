# Agent Note: Openness spec-loop adapter provider with an HTTP JSON bridge

Status: implemented

English | [中文](2026-09-04-openness-spec-loop-adapter.zh.md)

## Problem

The spec-loop capability shipped with an adapter seam and no provider: [the capability note](2026-09-02-spec-loop-capability.md) recorded that a real provider (CLI spawn/kill, telemetry parsing) was deferred work because no deployment owned one. A deployment then asked for one — TIA Portal Openness (Siemens), whose API is a Windows-only, in-process .NET library, so a Node adapter can only reach it through a host process.

## Decision

`@deepseek-ai/dsh-provider-openness` ships the first spec-loop adapter provider. The adapter registers `OpennessSpecLoopAdapter` as `ctx.specLoopAdapter` and speaks a small HTTP JSON protocol to an **Openness bridge** — a Windows host process that keeps one TIA Portal V21 project open and implements the shipped action (write candidate parameters to the bound global data block members' start values, compile, report `{ compileErrors, compileWarnings, compileMs }`).

- The protocol is four routes: `GET /health` (readiness + environment tuple), `POST /validate` (the cheap S1 gate), `POST /run` (`success|diverged|infrastructure|killed` plus metrics, license time, environment), `POST /cancel` (best effort — an in-flight Openness call cannot be preempted). Host outages surface as HTTP 503; runs are serialized (409).
- Two deployment modes, exactly one configured: `url` (a deployment-owned bridge) or `spawn` (the adapter owns a local bridge process, waits for its `{"event":"listening","url":…}` ready line, and kills it with the owning fiber). Misconfiguration fails at load.
- Bridge failures route through the seam's own vocabulary: timeouts, outages, and malformed responses settle `infrastructure` (S3); a cancelled run settles `killed` immediately with a fire-and-forget `/cancel`; `validate` transport failures throw so the engine classifies S3.
- The bundled C# bridge (`bridge/`) builds in two profiles: the default compiles the protocol server plus a deterministic `--fake` host (no TIA needed, so the wire layer is repo-CI verifiable), and `-p:WithOpenness=true` compiles the real Openness host against the installed TIA Portal V21 API. The shipped action's parameter domain is deployment-defined through the bridge config's `{ block, member, min, max }` global-DB member bindings.
- An example overlay, `examples/openness-spec-loop/cordis.yml`, mounts the provider and the `spec_loop` tool over the shipped Web composition.

## Alternatives considered

- **Adapter spawns and drives TIA Openness directly (in-process .NET through a native addon).** Openness is a Windows-only .NET Framework API with no stable Node interop story; a host process keeps the TIA session warm across candidate runs and isolates license-heavy calls. Rejected.
- **stdio (newline-delimited JSON) instead of HTTP for the bridge.** HTTP lets the bridge run on a different Windows machine than the harness, matches the deployment shape (TIA is licensed and installed where the project lives), and keeps the adapter testable against an in-process HTTP server without child processes. Rejected.
- **Ship no C# bridge, protocol only.** The repo would then have no reference implementation and no way to smoke the protocol end to end; the fake host doubles as the wiring demo on machines without TIA. Rejected.
- **Put the provider in `packages/experimental/`.** It is a complete capability-seam role with tests and a shipped example, so it belongs with its family under `packages/spec-loop/`. Rejected.

## Consequences

- The 2026-09-02 note's "no shipped provider" fact is partially superseded: a provider now ships; telemetry-stream early termination (S-5/S-6) remains deferred, and the bridge reports outcomes only when its Openness call settles.
- The real Openness host compiles only on a machine with TIA Portal V21: repo gates verify the protocol layer and the fake host, and the TIA-bound host is compile-verified against the installed V21 API (TIA V21 split the Openness API into `Siemens.Engineering.Base`/`.Step7` assemblies, hosts software behind the `SoftwareContainer` service, exposes compile through `GetService<ICompilable>()`, and exposes global data block member start values only as the dynamic `StartValue` attribute — the tag property surface is gone; the host aligns with V21). Runtime assembly resolution goes through the official `Siemens.Collaboration.Net.TiaPortal.Openness.Resolver` packages (Copy Local off), with an `AssemblyResolve` fallback over the registry-derived PublicAPI directory for non-default install roots. A real-machine run on TIA Portal V21 with a STEP 7 Professional trial license verified the complete chain — resolver, the `Siemens TIA Openness` group check, headless launch, folder-project open, project/device creation, the hardware-catalog lookup (`TypeIdentifier` has the `OrderNumber:<article>/<version>` form), the global-DB member start-value write plus a real compile reporting `compileErrors`/`compileWarnings`/`compileMs`, and an end-to-end `spec_loop` with real model generation settling `satisfied`.
- License accounting stays approximate: the bridge reports compile wall time as `licenseMs`; no license-pool ledger exists.
- Spawn-mode tests never launch a child process (the repo's test sandbox denies piped stdio spawns); the spawner is an injected seam, and the ready-line and kill-on-dispose behavior is covered with fakes plus one assembled-Web e2e boot in `apps/web/tests/openness-spec-loop.e2e.ts`.
