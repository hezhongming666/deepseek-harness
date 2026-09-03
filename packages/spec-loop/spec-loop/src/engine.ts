/**
 * The deterministic spec-loop engine: bounded, replayable, monotonic
 * candidate search against a spec contract. Given a typed spec, a generator,
 * and an adapter, it runs validate → execute → assert iterations, classifies
 * failures (S0-S3), tracks monotonic improvement with an epsilon margin, and
 * enforces iteration, wall-clock, and token budgets. All bookkeeping is a pure
 * function of the generation and adapter outcome sequence; the engine holds no
 * state beyond the run.
 * @module @deepseek-ai/dsh-spec-loop
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { evaluateAssertions, lookupNumber } from './assertions.ts'
import type {
  AdapterRunOutcome,
  Generation,
  IterationRecord,
  SpecLoopAdapter,
  SpecLoopGenerator,
  SpecLoopParams,
  SpecLoopReport,
  SpecLoopRunId,
  SpecLoopSpec,
  SpecLoopStatus,
  ValidationOutcome,
} from './types.ts'

/** Deployment ceilings that tighten the spec budgets; each may be omitted. */
export interface SpecLoopCeilings {
  maxIterations?: number
  maxWallClockMs?: number
  maxTokens?: number
}

/** One engine run: everything the loop needs, all caller-supplied. */
export interface SpecLoopRunRequest {
  runId: SpecLoopRunId
  spec: SpecLoopSpec
  generator: SpecLoopGenerator
  adapter: SpecLoopAdapter
  /** Optional starting candidate evaluated before any generation. */
  initialParams?: SpecLoopParams
  /** Deployment ceilings; each effective cap is the minimum with the spec budget. */
  ceilings?: SpecLoopCeilings
  /** Run cancellation; checked between iterations and forwarded to adapter runs. */
  signal?: AbortSignal
}

/** Total billed input for budget accounting: uncached input plus cache reads/writes. */
function billedInput(usage: TokenUsage): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

function addUsage(total: Required<TokenUsage>, usage: TokenUsage | undefined): void {
  if (usage === undefined) return
  total.inputTokens += usage.inputTokens
  total.outputTokens += usage.outputTokens
  if (usage.cacheReadTokens !== undefined) total.cacheReadTokens += usage.cacheReadTokens
  if (usage.cacheWriteTokens !== undefined) total.cacheWriteTokens += usage.cacheWriteTokens
  if (usage.reasoningTokens !== undefined) total.reasoningTokens += usage.reasoningTokens
}

/** Budget-relevant token count: billed input plus output. */
function budgetTokens(total: Required<TokenUsage>): number {
  return billedInput(total) + total.outputTokens
}

/** Strict monotonic improvement with the epsilon margin. */
function improves(previous: number, current: number, direction: 'minimize' | 'maximize', margin: number): boolean {
  return direction === 'minimize' ? current <= previous - margin : current >= previous + margin
}

/** Render any thrown value without letting the render itself throw. */
function renderError(error: unknown): string {
  try {
    return String(error instanceof Error ? error.message : error)
  } catch {
    return '[unrenderable thrown value]'
  }
}

/** Render one parameter bound violation for the validation reasons. */
function checkEnvelope(spec: SpecLoopSpec, params: SpecLoopParams): string[] {
  if (spec.envelope === undefined) return []
  const reasons: string[] = []
  for (const [path, bounds] of Object.entries(spec.envelope.bounds)) {
    const value = lookupNumber(params, path)
    if (value !== undefined && (value < bounds.min || value > bounds.max)) {
      reasons.push(`envelope: ${path} = ${value} outside [${bounds.min}, ${bounds.max}]`)
    }
  }
  return reasons
}

interface Candidate {
  params: SpecLoopParams
  model?: { provider: string; model: string }
  usage?: TokenUsage
}

/**
 * Evaluate one candidate: envelope, validation, adapter run, assertions, and
 * verdict classification. Never throws; adapter failures become S3 records.
 * @returns the filled record (objective, accepted, and counters stay pending).
 */
async function evaluateCandidate(
  spec: SpecLoopSpec,
  adapter: SpecLoopAdapter,
  candidate: Candidate,
  iteration: number,
  signal: AbortSignal | undefined,
): Promise<IterationRecord> {
  const startedAt = Date.now()
  const base = {
    iteration,
    params: candidate.params,
    ...candidate.model === undefined ? {} : { model: candidate.model },
    ...candidate.usage === undefined ? {} : { usage: candidate.usage },
    wallClockMs: 0,
  }

  const envelopeReasons = checkEnvelope(spec, candidate.params)
  if (envelopeReasons.length > 0) {
    return { ...base, validation: { ok: false, reasons: envelopeReasons }, verdict: 'S1', wallClockMs: Date.now() - startedAt }
  }

  let validation: ValidationOutcome
  try {
    validation = await adapter.validate(candidate.params)
  } catch (error) {
    return {
      ...base,
      verdict: 'S3',
      error: `adapter validation failed: ${renderError(error)}`,
      wallClockMs: Date.now() - startedAt,
    }
  }
  if (!validation.ok) {
    return { ...base, validation, verdict: 'S1', wallClockMs: Date.now() - startedAt }
  }

  let outcome: AdapterRunOutcome
  try {
    outcome = await adapter.run({ params: candidate.params, ...signal === undefined ? {} : { signal } })
  } catch (error) {
    return {
      ...base,
      verdict: 'S3',
      error: `adapter run failed: ${renderError(error)}`,
      wallClockMs: Date.now() - startedAt,
    }
  }

  const runFields = {
    runStatus: outcome.status,
    ...outcome.licenseMs === undefined ? {} : { licenseMs: outcome.licenseMs },
    ...outcome.error === undefined ? {} : { error: outcome.error },
    ...outcome.environment === undefined ? {} : { environment: outcome.environment },
  }

  switch (outcome.status) {
    case 'killed':
      return { ...base, ...runFields, verdict: 'cancelled', wallClockMs: Date.now() - startedAt }
    case 'diverged':
      return { ...base, ...runFields, verdict: 'S2', wallClockMs: Date.now() - startedAt }
    case 'infrastructure':
      return { ...base, ...runFields, verdict: 'S3', wallClockMs: Date.now() - startedAt }
    case 'success': {
      const result = outcome.result ?? {}
      const assertionResults = evaluateAssertions(result, spec.assertions)
      const objective = lookupNumber(result, spec.objective.path)
      if (objective === undefined) {
        return {
          ...base,
          ...runFields,
          assertionResults,
          verdict: 'S0',
          error: `objective metric ${JSON.stringify(spec.objective.path)} missing or non-numeric in the result`,
          wallClockMs: Date.now() - startedAt,
        }
      }
      if (assertionResults.every(assertion => assertion.passed)) {
        return { ...base, ...runFields, assertionResults, objective, verdict: 'satisfied', wallClockMs: Date.now() - startedAt }
      }
      return { ...base, ...runFields, assertionResults, objective, verdict: 'S0', wallClockMs: Date.now() - startedAt }
    }
  }
}

/**
 * Run one bounded spec loop to completion.
 * @param request - run id, spec, generator, adapter, optional initial
 *   candidate, ceilings, and cancellation signal.
 * @returns the complete report; the run always terminates on a status, a cap,
 *   or cancellation — it never rejects on adapter or generator failures.
 */
export async function runSpecLoop(request: SpecLoopRunRequest): Promise<SpecLoopReport> {
  const startedAt = Date.now()
  const { spec } = request

  const maxIterations = request.ceilings?.maxIterations === undefined
    ? spec.budgets.maxIterations
    : Math.min(spec.budgets.maxIterations, request.ceilings.maxIterations)
  const maxWallClockMs = minCap(spec.budgets.maxWallClockMs, request.ceilings?.maxWallClockMs)
  const maxTokens = minCap(spec.budgets.maxTokens, request.ceilings?.maxTokens)

  const margin = spec.repair.margin
  const maxNoImprovement = spec.repair.maxNoImprovement
  const maxConsecutiveInfrastructure = spec.repair.maxConsecutiveInfrastructure ?? 3

  const iterations: IterationRecord[] = []
  const tokens: Required<TokenUsage> = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  }
  let licenseMs = 0
  let best: { params: SpecLoopParams; objective: number } | null = null
  let noImprovement = 0
  let consecutiveInfrastructure = 0

  let nextCandidate: Candidate | undefined = request.initialParams === undefined
    ? undefined
    : { params: request.initialParams }

  const finish = (status: SpecLoopStatus): SpecLoopReport => ({
    runId: request.runId,
    specId: spec.id,
    status,
    iterations,
    best,
    costs: {
      wallClockMs: Date.now() - startedAt,
      iterations: iterations.length,
      tokens,
      licenseMs,
    },
  })

  for (;;) {
    if (request.signal?.aborted === true) return finish('cancelled')
    if (iterations.length >= maxIterations) return finish('budget-limited')
    if (maxWallClockMs !== undefined && Date.now() - startedAt >= maxWallClockMs) return finish('budget-limited')

    let candidate: Candidate
    if (nextCandidate !== undefined) {
      candidate = nextCandidate
      nextCandidate = undefined
    } else {
      if (maxTokens !== undefined && budgetTokens(tokens) >= maxTokens) return finish('budget-limited')
      let generation: Generation
      try {
        generation = await request.generator.generate({
          iteration: iterations.length + 1,
          spec,
          history: iterations,
          ...request.signal === undefined ? {} : { signal: request.signal },
        })
      } catch (error) {
        iterations.push({
          iteration: iterations.length + 1,
          verdict: 'generation-failed',
          error: renderError(error),
          wallClockMs: 0,
        })
        return finish('failed')
      }
      addUsage(tokens, generation.usage)
      candidate = generation
    }

    const record = await evaluateCandidate(spec, request.adapter, candidate, iterations.length + 1, request.signal)
    if (record.licenseMs !== undefined) licenseMs += record.licenseMs
    if (record.verdict === 'cancelled') {
      iterations.push(record)
      return finish('cancelled')
    }
    if (record.verdict === 'satisfied') {
      const params = record.params
      const objective = record.objective
      if (params === undefined || objective === undefined) {
        throw new Error('internal: a satisfied record must carry params and an objective')
      }
      record.accepted = true
      iterations.push(record)
      best = { params, objective }
      return finish('satisfied')
    }
    if (record.verdict === 'S0' && record.objective !== undefined) {
      const params = record.params
      if (params === undefined) {
        throw new Error('internal: an evaluated record must carry params')
      }
      if (best === null || improves(best.objective, record.objective, spec.objective.direction, margin)) {
        record.accepted = true
        best = { params, objective: record.objective }
        noImprovement = 0
      } else {
        record.accepted = false
        noImprovement += 1
      }
    }
    iterations.push(record)
    if (record.verdict === 'S0' && noImprovement >= maxNoImprovement) return finish('no-improvement')
    if (record.verdict === 'S3') {
      consecutiveInfrastructure += 1
      if (consecutiveInfrastructure >= maxConsecutiveInfrastructure) return finish('infrastructure-failed')
    } else {
      consecutiveInfrastructure = 0
    }
  }
}

/** Minimum of two optional positive caps, or undefined when both are absent. */
function minCap(specValue: number | undefined, ceiling: number | undefined): number | undefined {
  if (specValue === undefined) return ceiling
  if (ceiling === undefined) return specValue
  return Math.min(specValue, ceiling)
}
