# Spec Loop

[English](spec-loop.md) | 中文

spec-loop 能力在外部工程软件之上运行有界、可回放的参数搜索闭环：spec 契约给出目标与数值断言，确定性引擎对候选参数执行校验、执行、分级与单调修复，而软件集成只需实现下文这个小巧的适配器 seam。与 [workflow](workflow.md) 一样，它是**一项可选能力**，不属于 agent loop，因此其类型与操作记录在此处，而非 [core.md](core.md)。每个上下文只允许一个适配器提供 `ctx.specLoopAdapter`；没有命名提供方注册表（第二个适配器通过插件配置替换第一个，而不与它同时运行）。

Service Definition：[dsh-spec-loop](../../packages/spec-loop/spec-loop)（`ctx.specLoopAdapter`、引擎 `runSpecLoop`、spec 校验与下文词汇）。面向模型的 Consumer 是 [dsh-tool-spec-loop](../../packages/spec-loop/tool-spec-loop)，它注册 `spec_loop` 工具，并通过 LLM seam 的多模型回退链负责候选生成。仓库内随附一个 provider：[dsh-provider-openness](../../packages/spec-loop/provider-openness) 经 HTTP JSON 桥适配 TIA Portal Openness（该包同时拥有随附的 C# 桥宿主）；其他集成由部署方自行实现。

源码：seam 词汇位于 [`packages/spec-loop/spec-loop/src/types.ts`](../../packages/spec-loop/spec-loop/src/types.ts)，引擎位于 [`engine.ts`](../../packages/spec-loop/spec-loop/src/engine.ts)，spec 校验位于 [`spec.ts`](../../packages/spec-loop/spec-loop/src/spec.ts)。

## 适配器 seam 词汇

适配器实现所需的全部词汇。参数与指标都是无损 JSON 值；`validate` 是廉价的预检查（S1 关卡），`run` 在可取消的前提下执行。

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

适配器通过结果状态报告求解发散与基础设施故障，绝不抛出异常；引擎仍会把抛出的适配器方法异常归类为 S3。

## spec 契约

`SpecLoopSpec` 是模型提供的单任务契约（在传输边界由 `validateSpec` 校验，畸形 spec 以 `INVALID_SPEC` 的 `SpecLoopError` 拒绝）：`id`、`objective`（`path` + `direction: 'minimize' | 'maximize'`）、非空 `assertions` 列表（`id`、`path`、`predicate: 'lte' | 'gte' | 'between'` 与阈值——数值，或 `between` 的 `[min, max]` 对）、`budgets`（`maxIterations`，可选 `maxWallClockMs` 与 `maxTokens`）、`repair`（`margin`、`maxNoImprovement`，可选 `maxConsecutiveInfrastructure`，默认 3）、可选的参数数值包络 `envelope`（在校验前检查）与喂给生成器的可选 `description`。逐字段契约见[包 README](../../packages/spec-loop/spec-loop/README.md)。

## 闭环

`runSpecLoop` 是其输入的纯函数：每个候选参数依次经过 envelope → `validate` → `run` → 断言，并被唯一归类为 `satisfied`、`S0`（断言未达标——唯一可修复的类别）、`S1`（包络或校验拒绝）、`S2`（发散）、`S3`（基础设施）、`generation-failed` 或 `cancelled`。单调修复只在改进超过 `repair.margin` 时替换当前最优；连续 `maxNoImprovement` 次未改善以 `no-improvement` 停止，连续 `maxConsecutiveInfrastructure` 次 S3 以 `infrastructure-failed` 停止，生成器抛错以 `failed` 停止。预算是 spec 预算与可选部署上限的较小值。终止报告携带完整的逐迭代审计轨迹、最优已验收候选与汇总成本（墙钟、许可证时长、计费 Token、迭代数）。全部记账都是生成与适配器结果序列的纯函数，因此回放就是让生成器回放已记录提案的一次运行。

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
