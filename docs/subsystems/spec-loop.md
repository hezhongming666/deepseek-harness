# Spec Loop

English | [中文](spec-loop.zh.md)

The spec-loop capability runs bounded, replayable parameter-search loops over external engineering software: a spec contract names the objective and numeric assertions, the deterministic engine validates, executes, classifies, and monotonic-repairs candidates, and the software integration implements the small adapter seam below. Like [workflow](workflow.md) it is **one optional capability**, not part of the agent loop, so its types and operations live here rather than in [core.md](core.md). One adapter per context provides `ctx.specLoopAdapter`; there is no named-provider registry (a second adapter replaces the first through plugin configuration rather than running beside it).

Service Definition: [dsh-spec-loop](../../packages/spec-loop/spec-loop) (`ctx.specLoopAdapter`, the engine `runSpecLoop`, spec validation, and the vocabulary below). The model-facing Consumer is [dsh-tool-spec-loop](../../packages/spec-loop/tool-spec-loop), which registers the `spec_loop` tool and owns candidate generation through the LLM seam with a multi-model fallback chain. Adapter providers are deployment-owned; the package ships none.

Sources: the seam vocabulary in [`packages/spec-loop/spec-loop/src/types.ts`](../../packages/spec-loop/spec-loop/src/types.ts), the engine in [`engine.ts`](../../packages/spec-loop/spec-loop/src/engine.ts), spec validation in [`spec.ts`](../../packages/spec-loop/spec-loop/src/spec.ts).

## The adapter seam vocabulary

The complete vocabulary an adapter implementation works with. Params and metrics are lossless-JSON values; `validate` is the cheap pre-check (the S1 gate), `run` executes with cancellation.

```ts type-equiv
/** Lossless-JSON wire value used by spec-loop params and metrics. */
type SpecLoopJson = null | boolean | number | string | SpecLoopJson[] | { [key: string]: SpecLoopJson }
```

```ts type-equiv
/** One candidate parameter set proposed for evaluation. */
type SpecLoopParams = { [key: string]: SpecLoopJson }
```

```ts type-equiv
/** Structured numeric metrics returned by a successful adapter run. */
type SpecLoopMetrics = { [key: string]: SpecLoopJson }
```

```ts type-equiv
/** Dry-run validation outcome: the S1 gate before any license is consumed. */
interface ValidationOutcome {
  ok: boolean
  /** Non-empty reasons when refused. */
  reasons: string[]
}
```

```ts type-equiv
/** A candidate handed to the adapter for validation and execution. */
interface AdapterRunRequest {
  params: SpecLoopParams
  /** Cancellation forwarded by the engine; the adapter must settle promptly. */
  signal?: AbortSignal
}
```

```ts type-equiv
/** Adapter-reported outcome status; `killed` means the run signal aborted it. */
type AdapterRunStatus = 'success' | 'diverged' | 'infrastructure' | 'killed'
```

```ts type-equiv
/** Optional deployment-environment facts recorded per iteration (version locking). */
interface AdapterEnvironment {
  softwareVersion?: string
  solverVersion?: string
  licenseServerVersion?: string
  osKernel?: string
}
```

```ts type-equiv
/** The adapter's report for one submitted run. */
interface AdapterRunOutcome {
  status: AdapterRunStatus
  /** Structured numeric metrics; present exactly for `success`. */
  result?: SpecLoopMetrics
  /** License time consumed by this run, in milliseconds, when the adapter reports it. */
  licenseMs?: number
  /** Non-empty diagnosis for `diverged`/`infrastructure`/`killed`. */
  error?: string
  /** Version tuple recorded into the audit trail (X-1). */
  environment?: AdapterEnvironment
}
```

Adapters report solver divergence and infrastructure failures through the outcome status, never by throwing; the engine still classifies a thrown adapter method as S3.

## The spec contract

`SpecLoopSpec` is the per-task contract the model supplies (validated at the wire boundary by `validateSpec`, which rejects malformed specs with an `INVALID_SPEC` `SpecLoopError`): `id`, the `objective` (`path` + `direction: 'minimize' | 'maximize'`), a non-empty `assertions` list (`id`, `path`, `predicate: 'lte' | 'gte' | 'between'`, and the threshold — a number, or a `[min, max]` pair for `between`), `budgets` (`maxIterations`, optional `maxWallClockMs` and `maxTokens`), `repair` (`margin`, `maxNoImprovement`, optional `maxConsecutiveInfrastructure`, default 3), an optional `envelope` of numeric parameter bounds checked before validation, and an optional `description` fed to the generator. Field-by-field contracts live in the [package README](../../packages/spec-loop/spec-loop/README.md).

## The loop

`runSpecLoop` is a pure function of its inputs: each candidate is evaluated through envelope → `validate` → `run` → assertions and classified exactly once as `satisfied`, `S0` (assertions failed — the only repairable class), `S1` (envelope or validation refusal), `S2` (divergence), `S3` (infrastructure), `generation-failed`, or `cancelled`. Monotonic repair replaces the current best only on improvement beyond `repair.margin`; `maxNoImprovement` consecutive misses stop the run with `no-improvement`, `maxConsecutiveInfrastructure` consecutive S3 with `infrastructure-failed`, and a generator throw with `failed`. Budgets are the minimum of the spec budgets and optional deployment ceilings. The terminal report carries the full per-iteration audit trail, the best accepted candidate, and summed costs (wall clock, license time, billed tokens, iterations). All bookkeeping is a pure function of the generation and adapter outcome sequence, so a replay is a run whose generator feeds logged proposals back.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxspecloopadapter--specloopadapterservice-abstract-seam"></a>

### `ctx.specLoopAdapter` — `SpecLoopAdapterService` (abstract seam)

The adapter contract one industrial-software integration implements. Both methods are per-call operations; implementations keep no job state between calls and honor the request signal in `run` (H-3).

```ts cordis-catalog
/**
 * Cheap feasibility pre-check (S-7 dry-run): reject infeasible parameters
 * without consuming license or resources.
 * @param params - the candidate parameter set.
 * @returns the S1 gate outcome.
 */
abstract validate(params: SpecLoopParams): Promise<ValidationOutcome>

/**
 * Execute one candidate through the software and return the structured
 * outcome (S-5). Solver divergence and infrastructure failures are outcome
 * statuses, never thrown exceptions.
 * @param request - the candidate plus the cancellation signal.
 * @returns the run outcome.
 */
abstract run(request: AdapterRunRequest): Promise<AdapterRunOutcome>
```

Source: [`packages/spec-loop/spec-loop/src/adapter.ts:28`](../../packages/spec-loop/spec-loop/src/adapter.ts)
<!-- END GENERATED cordis-surface -->
