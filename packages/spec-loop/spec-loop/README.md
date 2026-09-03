# @deepseek-ai/dsh-spec-loop

English | [中文](README.zh.md)

The deterministic spec-loop core: a bounded, replayable candidate-search engine over a spec contract, plus the adapter seam industrial-software integrations implement. Model-facing behavior lives in [`dsh-tool-spec-loop`](../tool-spec-loop/README.md).

## The engine

`runSpecLoop(request)` runs validate → execute → assert iterations until the spec terminates the run. Each candidate is classified into exactly one verdict:

| Verdict | Meaning | Loop policy |
| :--- | :--- | :--- |
| `satisfied` | All assertions passed | Accept as best and stop |
| `S0` | Ran successfully but assertions failed | Monotonic repair: replaces the best only on improvement beyond the spec's `repair.margin`; `maxNoImprovement` consecutive misses stop the run |
| `S1` | Envelope bound violated or `adapter.validate` refused | Record reasons, propose again; never reaches the software |
| `S2` | Adapter reported divergence | Record, propose again with the divergence diagnosis in history |
| `S3` | Adapter threw or reported infrastructure failure | `maxConsecutiveInfrastructure` consecutive failures stop the run |
| `generation-failed` | The generator threw (every fallback exhausted) | Stop with status `failed` |
| `cancelled` | Signal aborted an adapter run | Stop with status `cancelled` |

Terminal statuses: `satisfied`, `budget-limited` (iterations, wall clock, or billed tokens), `no-improvement`, `infrastructure-failed`, `failed`, `cancelled`.

Budgets are the minimum of the spec budgets and the optional deployment `ceilings`; token accounting counts billed input (uncached + cache reads + cache writes) plus output. License time is summed from adapter outcomes and reported in `costs.licenseMs`, never enforced here.

## Determinism and replay

All bookkeeping — iteration numbering, monotonic best tracking, counters, and costs — is a pure function of the outcome sequence. The engine holds no state between runs. A replay is a run whose generator feeds logged proposals back instead of calling a model, against a scripted adapter; the engine needs no replay mode.

## The adapter seam

`SpecLoopAdapterService` (ctx key `specLoopAdapter`) is the Service Definition one software integration implements:

- `validate(params)` — the cheap S1 gate: reject infeasible parameters without consuming license or resources.
- `run(request)` — execute one candidate; report `success`/`diverged`/`infrastructure`/`killed` outcomes with structured metrics (`result`), optional `licenseMs`, `error`, and the version tuple `environment` (`softwareVersion`, `solverVersion`, `licenseServerVersion`, `osKernel`) for the audit trail.

Providers report solver and infrastructure failures through outcome statuses, never by throwing; the engine still classifies thrown adapter errors as S3.

## Model Experience

Indirectly, through `dsh-tool-spec-loop`, which registers the `spec_loop` tool, its system-prompt section, and its rendered reports; this package registers no prompt, schema, or result of its own.

#### KV Cache effect

Independent — this package issues no model requests.

## Known Limitations and Deferred Work

- **No telemetry-stream early termination** — the adapter outcome is collected only at run completion; the engine does not consume incremental residual/iteration telemetry to kill a diverging run early (S-5/S-6). An adapter can still approximate it by returning `diverged` with a diagnosis.
- **No license-pool cap enforcement** — license time is summed into `costs.licenseMs` and reported; the engine cannot know a deployment's pool size, so it never stops a run for license reasons.
- **No durable daily budget** — budgets are per-run only; a cross-run daily token/wall-clock ledger needs a persistence seam and is not implemented.
- **No checkpoint/resume integration** — warm-start checkpoints (S-6) are the adapter's concern; the engine neither inspects nor resumes them.
