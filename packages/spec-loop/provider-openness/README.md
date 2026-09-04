# @deepseek-ai/dsh-provider-openness

English | [中文](README.zh.md)

The **spec-loop adapter provider for Siemens TIA Portal Openness**. It registers one `OpennessSpecLoopAdapter` as `ctx.specLoopAdapter`, so the `spec_loop` tool runs bounded parameter-search loops against a TIA Portal V21 project through an Openness bridge. The provider ships the adapter, the wire protocol, and the spawn-mode bridge lifecycle; the bundled [C# bridge](bridge/README.md) is the deployment's Openness host.

| Piece | Role |
|---|---|
| `OpennessSpecLoopAdapter` | The `specLoopAdapter` provider: `validate` (the S1 gate) and `run` (execution with cancellation) over HTTP JSON |
| [bridge/](bridge/README.md) | Windows host process: keeps one TIA Portal V21 project open, serves the protocol on 127.0.0.1, and implements the shipped `compile`, `online` (download + read-back), and `generate` (SCL template to block) actions (plus a deterministic `--fake` mode) |
| `src/wire.ts` | Hostile-input validation of every bridge response (the bridge is an external process) |

## The wire protocol

The bridge speaks plain HTTP JSON. `GET /health` reports readiness and the environment tuple; `POST /validate` receives `{ params }` and returns `{ ok, reasons }`; `POST /run` receives `{ runId, params }` and returns `{ runId, status: success|diverged|infrastructure|killed, result?, licenseMs?, error?, environment? }`; `POST /cancel` receives `{ runId }` and is best effort, because an in-flight Openness call cannot be preempted. Host outages surface as HTTP 503; a run in flight makes the next one a 409.

The shipped actions' parameter domain is deployment-defined: the bridge config maps each parameter key to one global-DB member (`{ block, member, min, max }`), and a run writes the candidate's numeric values into those members' start values (V21's dynamic `StartValue` attribute) before running the configured action. The `compile` action (default) compiles the PLC and carries `{ compileErrors, compileWarnings, compileMessages, compileMs }`; the `online` action downloads to an S7-PLCSIM simulation target, goes online, and carries `{ downloadState, downloadMessages, onlineValues, readMs, downloadMs }`; the `generate` action renders a config SCL template with the candidate's values, imports the block, and carries the compile fields plus `blockName` (its `params` map supplies only the numeric domain). The measured wall span is reported as `licenseMs`.

## Config

All fields live under the `provider-openness` entry `config`; exactly one of `url` and `spawn.command` is required.

```ts
import type { Config } from '@deepseek-ai/dsh-provider-openness'
// {
//   url: string,              // base URL of a running bridge
//   spawn: {                  // the adapter owns a local bridge process
//     command: string,        // e.g. 'dotnet'
//     args: string[],         // e.g. ['OpennessBridge.dll']
//     cwd: string,
//     port: number,           // 0 = the bridge picks one and reports it
//     readyTimeoutMs: number,
//   },
//   requestTimeoutMs: number, // per-request cap; overruns report infrastructure
// }
```

Misconfiguration (neither or both modes, non-http URLs, out-of-range caps) fails at load. In spawn mode the adapter starts the bridge on first use, waits for its `{"event":"listening","url":…}` ready line, and kills the child with the owning fiber. Bridge outages, timeouts, and malformed responses surface as `infrastructure` outcomes (S3); a cancelled run settles `killed` immediately with a fire-and-forget `/cancel`; `validate` transport failures throw so the engine classifies them S3.

## Model Experience

Indirectly, through `dsh-tool-spec-loop`, which renders every run's report; the adapter feeds only the per-iteration outcomes it receives from the bridge.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **No telemetry-stream early termination** — the bridge reports an outcome only when its Openness call settles; divergence is detected from the terminal compile result, not from incremental solver telemetry.
- **The real Openness host is compile-verified, runtime machine-verified for the compile and generate actions** — the repo build compiles the protocol layer and the fake host anywhere, and the TIA-bound host compiles against the installed V21 API on a TIA machine (the V21 software/compile/DB-member surfaces were aligned in-repo); a TIA Portal V21 machine with a STEP 7 Professional trial license verified the full compile-action chain — headless open, global-DB member start-value write, compile, and a keyed `spec_loop` settling `satisfied` — plus the generate-action chain — SCL template render, block import through the external-source route, compile with message feedback, and a keyed `spec_loop` that recovered from a deliberate division-by-zero divergence to `satisfied` (see the [bridge README](bridge/README.md)). The `online` action's download and read-back paths are compile-verified against V21; their runtime verification awaits an S7-PLCSIM installation on the TIA machine.
- **Cancel cannot preempt Openness** — the `/cancel` call drops the result once the in-flight call settles; license time up to that point is still consumed.
- **License accounting is compile wall time** — the bridge reports the compile's wall-clock span as `licenseMs`; a real license-pool ledger stays with the deployment.
