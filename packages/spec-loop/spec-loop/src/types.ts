/**
 * Spec-loop domain types: the spec contract, the failure classification, the
 * iteration/report records, and the generator/adapter contracts the engine
 * consumes. Types only — no runtime code.
 * @module @deepseek-ai/dsh-spec-loop/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'

/** Lossless-JSON wire value used by spec-loop params and metrics. */
export type SpecLoopJson = null | boolean | number | string | SpecLoopJson[] | { [key: string]: SpecLoopJson }

/** One candidate parameter set proposed for evaluation. */
export type SpecLoopParams = { [key: string]: SpecLoopJson }

/** Structured numeric metrics returned by a successful adapter run. */
export type SpecLoopMetrics = { [key: string]: SpecLoopJson }

/** Identifies exactly one spec-loop run; owned by this package. */
export type SpecLoopRunId = Branded<'SpecLoopRunId'>

/** The metric whose monotonic improvement the loop tracks. */
export interface ObjectiveMetric {
  /** Dot path into the adapter result, e.g. `max_stress_MPa`. */
  path: string
  /** Whether the loop improves by lowering or raising the metric. */
  direction: 'minimize' | 'maximize'
}

/** One acceptance predicate over a numeric metric path. */
export interface Assertion {
  /** Stable identifier reported per-iteration in assertion results. */
  id: string
  /** Dot path into the adapter result. */
  path: string
  /**
   * Comparison applied to the looked-up value. `lte`/`gte` compare against a
   * single `target`; `between` compares against a `[min, max]` pair, both
   * inclusive.
   */
  predicate: 'lte' | 'gte' | 'between'
  /** Threshold for `lte`/`gte`, or the inclusive `[min, max]` pair for `between`. */
  target: number | [number, number]
}

/** Per-spec budgets; each cap may be tightened by a deployment ceiling. */
export interface SpecBudgets {
  /** Positive safe-integer iteration cap. */
  maxIterations: number
  /** Optional wall-clock cap for the whole run, in milliseconds. */
  maxWallClockMs?: number
  /** Optional cap on billed generation tokens (input + output) for the whole run. */
  maxTokens?: number
}

/** Numeric bounds for one parameter path; violations never reach the adapter. */
export interface ParameterBounds {
  min: number
  max: number
}

/** Optional design envelope: numeric parameter bounds enforced before validation. */
export interface ParameterEnvelope {
  /** Parameter dot paths to their inclusive numeric bounds. */
  bounds: Readonly<{ [path: string]: ParameterBounds }>
}

/** Repair policy: the formalization of monotonic improvement. */
export interface RepairPolicy {
  /**
   * Epsilon margin: a new objective replaces the current best only when it
   * improves by at least this amount.
   */
  margin: number
  /**
   * Consecutive non-improving S0 iterations after which the run reports
   * `no-improvement`.
   */
  maxNoImprovement: number
  /**
   * Consecutive S3 (infrastructure) iterations after which the run reports
   * `infrastructure-failed`. Defaults to 3.
   */
  maxConsecutiveInfrastructure?: number
}

/**
 * The spec contract: what is optimized, what is accepted, and what the loop
 * may spend. Written once per software task; the engine is a pure function of
 * it plus the generation and adapter outcomes.
 */
export interface SpecLoopSpec {
  /** Stable spec identifier recorded in every report. */
  id: string
  /** The metric whose monotonic improvement the loop tracks. */
  objective: ObjectiveMetric
  /** Non-empty acceptance predicates; all must pass for a satisfied run. */
  assertions: readonly Assertion[]
  /** Iteration, wall-clock, and token budgets. */
  budgets: SpecBudgets
  /** Monotonic-improvement and infrastructure-failure policy. */
  repair: RepairPolicy
  /** Optional numeric parameter bounds enforced before adapter validation. */
  envelope?: ParameterEnvelope
  /** Optional guidance for the generator describing what the parameters mean. */
  description?: string
}

/**
 * Failure class of one evaluated candidate. S0 is the only repairable class;
 * S1-S3 are exceptions routed differently by the engine.
 */
export type FailureClass = 'S0' | 'S1' | 'S2' | 'S3'

/** Per-iteration verdict, including the terminal non-failure outcomes. */
export type IterationVerdict = 'satisfied' | FailureClass | 'generation-failed' | 'cancelled'

/** Evaluation of one assertion against one result. */
export interface AssertionResult {
  id: string
  passed: boolean
  /** The looked-up numeric value; absent when the path is missing or non-numeric. */
  actual?: number
}

/** Adapter-reported outcome status; `killed` means the run signal aborted it. */
export type AdapterRunStatus = 'success' | 'diverged' | 'infrastructure' | 'killed'

/** Optional deployment-environment facts recorded per iteration (version locking). */
export interface AdapterEnvironment {
  softwareVersion?: string
  solverVersion?: string
  licenseServerVersion?: string
  osKernel?: string
}

/** The adapter's report for one submitted run. */
export interface AdapterRunOutcome {
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

/** A candidate handed to the adapter for validation and execution. */
export interface AdapterRunRequest {
  params: SpecLoopParams
  /** Cancellation forwarded by the engine; the adapter must settle promptly. */
  signal?: AbortSignal
}

/** Dry-run validation outcome: the S1 gate before any license is consumed. */
export interface ValidationOutcome {
  ok: boolean
  /** Non-empty reasons when refused. */
  reasons: string[]
}

/**
 * The adapter seam one industrial-software integration implements: cheap
 * pre-validation plus run execution with cancellation.
 */
export interface SpecLoopAdapter {
  /**
   * Reject infeasible parameters without consuming license or resources.
   * @param params - the candidate parameter set.
   * @returns the S1 gate outcome.
   */
  validate(params: SpecLoopParams): Promise<ValidationOutcome>
  /**
   * Execute one candidate through the software and return the structured
   * outcome. Implementations report solver divergence and infrastructure
   * failure through the outcome, never by throwing ordinary exceptions.
   * @param request - the candidate plus the cancellation signal.
   * @returns the run outcome.
   */
  run(request: AdapterRunRequest): Promise<AdapterRunOutcome>
}

/** Context passed to the generator for one proposal. */
export interface GenerationContext {
  /** One-based iteration number this proposal will carry. */
  iteration: number
  /** The validated spec contract, read-only. */
  spec: SpecLoopSpec
  /** Prior iteration records, oldest first, bounded by the tool. */
  history: readonly IterationRecord[]
  /** Run cancellation forwarded to the model call. */
  signal?: AbortSignal
}

/** One generator proposal: the params plus provenance and usage. */
export interface Generation {
  params: SpecLoopParams
  /** Which fallback model produced this proposal. */
  model: { provider: string; model: string }
  /** Provider-reported usage, when the stream carried it. */
  usage?: TokenUsage
}

/**
 * Proposes one candidate parameter set per iteration. The tool's
 * multi-model-fallback generator implements this; a replay generator can feed
 * logged proposals back for deterministic re-execution.
 */
export interface SpecLoopGenerator {
  /**
   * @param context - iteration number, spec, and bounded prior history.
   * @returns one proposal; throwing means every fallback failed.
   */
  generate(context: GenerationContext): Promise<Generation>
}

/** Full per-iteration audit record. */
export interface IterationRecord {
  /** One-based iteration number. */
  iteration: number
  /** The evaluated candidate; absent only for `generation-failed`. */
  params?: SpecLoopParams
  /** The model that proposed the candidate; absent for the initial params and for failures. */
  model?: { provider: string; model: string }
  /** The S1 gate result; present when validation or the envelope refused. */
  validation?: ValidationOutcome
  /** Adapter outcome status; present when the adapter executed the candidate. */
  runStatus?: AdapterRunStatus
  /** Per-assertion evaluation; present exactly for `success` runs. */
  assertionResults?: AssertionResult[]
  /** The looked-up objective value; present when the result carried it. */
  objective?: number
  /** Whether this record replaced the current best (monotonic acceptance). */
  accepted?: boolean
  verdict: IterationVerdict
  /** Provider-reported usage for the proposal generation, when present. */
  usage?: TokenUsage
  /** License time this iteration consumed, in milliseconds, when reported. */
  licenseMs?: number
  /** Diagnosis for S2/S3/generation-failed or a missing objective metric. */
  error?: string
  /** Version tuple reported by the adapter, when present. */
  environment?: AdapterEnvironment
  /** Wall-clock time this iteration took, in milliseconds. */
  wallClockMs: number
}

/** Terminal run status: why the loop stopped. */
export type SpecLoopStatus =
  | 'satisfied'
  | 'budget-limited'
  | 'no-improvement'
  | 'infrastructure-failed'
  | 'failed'
  | 'cancelled'

/** Summed cost accounting for one run (license, wall clock, tokens, iterations). */
export interface SpecLoopCosts {
  wallClockMs: number
  iterations: number
  /** Summed usage across all generation calls; zero-filled fields are always present. */
  tokens: Required<TokenUsage>
  /** Summed license time reported by the adapter, in milliseconds. */
  licenseMs: number
}

/** The engine's complete terminal report: status, audit trail, best, and costs. */
export interface SpecLoopReport {
  runId: SpecLoopRunId
  specId: string
  status: SpecLoopStatus
  /** Every iteration, oldest first. */
  iterations: IterationRecord[]
  /** The best accepted objective so far; null when no candidate was evaluated. */
  best: { params: SpecLoopParams; objective: number } | null
  costs: SpecLoopCosts
}
