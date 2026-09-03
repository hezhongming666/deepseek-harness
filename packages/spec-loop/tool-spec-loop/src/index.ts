/**
 * Model-facing `spec_loop` tool: one call runs the complete deterministic
 * parameter-search loop over the mounted spec-loop adapter. The tool owns
 * generation (multi-model fallback through the LLM seam), the deployment
 * ceilings, and the rendered report; the engine owns the loop bookkeeping.
 * @module @deepseek-ai/dsh-tool-spec-loop
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, GenerateOptions, TokenUsage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import {
  SpecLoopError,
  SpecLoopRunId,
  runSpecLoop,
  validateSpec,
} from '@deepseek-ai/dsh-spec-loop'
import type {
  Generation,
  GenerationContext,
  IterationRecord,
  SpecLoopGenerator,
  SpecLoopParams,
  SpecLoopSpec,
} from '@deepseek-ai/dsh-spec-loop'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
// Declaration merge only: makes ctx.systemPrompt visible for section registration.
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'tool-spec-loop'
export const inject = ['tools', 'systemPrompt', 'llm']

/** One generation target in the ordered fallback chain. */
export interface ModelTarget {
  provider: string
  model: string
}

/** Deployment configuration for the spec-loop tool. */
export interface Config {
  /** Ordered generation fallback chain; a later entry runs only after every earlier one failed. */
  models: ModelTarget[]
  /** Deployment ceiling for one run's iteration count (default 256). */
  maxIterations?: number
  /** Deployment ceiling for one run's wall-clock budget in milliseconds (default 3_600_000). */
  maxWallClockMs?: number
  /** Deployment ceiling for one run's billed generation tokens (default 200_000). */
  maxTokens?: number
  /** Output cap for one generation call (default 4096). */
  maxGenerationTokens?: number
  /** How many prior iteration records the next generation prompt embeds (default 16). */
  maxHistoryRecords?: number
  /** Serialized-character cap for one embedded record's params (default 2048). */
  maxParamsChars?: number
  /** Rendered-report character cap (default 16384). */
  maxResultChars?: number
}

/** Schemastery configuration for the spec-loop tool. */
export const Config: z<Config> = z.object({
  models: z.array(z.object({
    provider: z.string(),
    model: z.string(),
  })).required(),
  maxIterations: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(256),
  maxWallClockMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(3_600_000),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(200_000),
  maxGenerationTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(4096),
  maxHistoryRecords: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(16),
  maxParamsChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(2048),
  maxResultChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(16_384),
})

interface ResolvedConfig {
  readonly models: readonly ModelTarget[]
  readonly maxIterations: number
  readonly maxWallClockMs: number
  readonly maxTokens: number
  readonly maxGenerationTokens: number
  readonly maxHistoryRecords: number
  readonly maxParamsChars: number
  readonly maxResultChars: number
}

const DEFAULTS = {
  maxIterations: 256,
  maxWallClockMs: 3_600_000,
  maxTokens: 200_000,
  maxGenerationTokens: 4096,
  maxHistoryRecords: 16,
  maxParamsChars: 2048,
  maxResultChars: 16_384,
} as const

/** Validate semantic constraints the config schema cannot express. */
function resolveConfig(config: Config): ResolvedConfig {
  const models = config.models
  if (models.length === 0) {
    throw new TypeError('spec-loop config requires a non-empty models fallback chain')
  }
  for (const target of models) {
    if (target.provider.trim().length === 0) {
      throw new TypeError('spec-loop config model providers must be non-empty strings')
    }
    if (target.model.trim().length === 0) {
      throw new TypeError('spec-loop config model ids must be non-empty strings')
    }
  }
  const read = (field: keyof typeof DEFAULTS): number => {
    const value = config[field] ?? DEFAULTS[field]
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`spec-loop config ${field} must be a positive safe integer`)
    }
    return value
  }
  return {
    models: models.map(target => ({ provider: target.provider.trim(), model: target.model.trim() })),
    maxIterations: read('maxIterations'),
    maxWallClockMs: read('maxWallClockMs'),
    maxTokens: read('maxTokens'),
    maxGenerationTokens: read('maxGenerationTokens'),
    maxHistoryRecords: read('maxHistoryRecords'),
    maxParamsChars: read('maxParamsChars'),
    maxResultChars: read('maxResultChars'),
  }
}

const GENERATION_SYSTEM = 'You propose parameter sets for a deterministic spec loop over engineering software. '
  + 'Respond with exactly one JSON object whose keys are the parameter names and whose values are numbers, '
  + 'booleans, strings, or nested objects — no prose, no markdown, no explanation.'

const DESCRIPTION = 'Run a deterministic spec loop: iterate candidate parameters against a spec contract '
  + '(objective metric, assertions, budgets, repair policy) through the mounted spec-loop adapter, with '
  + 'multi-model generation fallback and monotonic repair, until the assertions pass or a budget, '
  + 'improvement, or infrastructure limit stops the run. The call returns the complete audit report: '
  + 'per-iteration verdicts (S0 assertion failures are repairable; S1 input-invalid, S2 divergence, and S3 '
  + 'infrastructure failures are classified separately), the best accepted parameters, and the cost totals. '
  + 'Use for bounded parameter search over software with a spec-loop adapter.'

const SECTION_TEXT = 'Use the spec_loop tool only for iterative parameter search against a spec contract '
  + 'evaluated by a mounted spec-loop adapter. One call runs the whole deterministic loop: multi-model '
  + 'generation, validation, monotonic repair, and cost caps are enforced inside the tool. You select the '
  + 'spec and act on the returned report; prefer it over repeated manual trial when numeric assertions exist.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Map a terminal generation finish to its fail-closed error. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens': {
      const error = new Error('spec-loop generation truncated at the token cap (incomplete JSON)') as Error & { code?: string }
      error.code = 'MAX_TOKENS'
      return error
    }
    default:
      return undefined
  }
}

/** Extract the concatenated text content of assembled blocks. */
function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Parse one generated reply into a JSON parameter object, fences tolerated. */
function parseParams(text: string): SpecLoopParams | undefined {
  const trimmed = text.trim()
  const attempts = [trimmed]
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first !== -1 && last > first) attempts.push(trimmed.slice(first, last + 1))
  for (const attempt of attempts) {
    try {
      const value: unknown = JSON.parse(attempt)
      if (isRecord(value)) return value as SpecLoopParams
    } catch {
      // The next attempt may still parse.
    }
  }
  return undefined
}

const TRUNCATION_NOTICE = '… [truncated]'

/** Bound embedded text, including the truncation marker. */
function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars <= TRUNCATION_NOTICE.length) return TRUNCATION_NOTICE.slice(0, maxChars)
  return `${text.slice(0, maxChars - TRUNCATION_NOTICE.length)}${TRUNCATION_NOTICE}`
}

/** One bounded prior-record summary embedded into the next generation prompt. */
function summarizeRecord(record: IterationRecord, maxParamsChars: number): unknown {
  const params = record.params === undefined
    ? undefined
    : truncateText(JSON.stringify(record.params), maxParamsChars)
  return {
    iteration: record.iteration,
    verdict: record.verdict,
    ...record.runStatus === undefined ? {} : { runStatus: record.runStatus },
    ...record.objective === undefined ? {} : { objective: record.objective },
    ...record.error === undefined ? {} : { error: record.error },
    ...params === undefined ? {} : { params },
    ...record.assertionResults === undefined ? {} : { assertionResults: record.assertionResults },
  }
}

/** Build the user prompt for one generation call from the bounded history. */
function buildGenerationPrompt(context: GenerationContext, resolved: ResolvedConfig): string {
  const { spec, history } = context
  const lines = [
    `Propose candidate parameters for spec ${JSON.stringify(spec.id)}.`,
  ]
  if (spec.description !== undefined) lines.push(`Spec description: ${spec.description}`)
  lines.push(`Objective: ${spec.objective.path} (${spec.objective.direction}).`)
  lines.push('Assertions, all of which must pass:')
  for (const assertion of spec.assertions) {
    lines.push(`- ${assertion.id}: ${assertion.path} ${assertion.predicate} ${JSON.stringify(assertion.target)}`)
  }
  if (spec.envelope !== undefined) lines.push(`Parameter bounds: ${JSON.stringify(spec.envelope.bounds)}`)
  lines.push(`Iteration ${context.iteration} of ${spec.budgets.maxIterations}.`)
  lines.push(
    `Repair policy: improve ${spec.objective.path} (${spec.objective.direction}) by more than `
    + `${spec.repair.margin} over the current best, without violating the assertions.`,
  )
  const records = history.slice(-resolved.maxHistoryRecords)
  const summary = JSON.stringify(records.map(record => summarizeRecord(record, resolved.maxParamsChars)), null, 2)
  lines.push(`History, oldest first:\n${summary}`)
  lines.push('Return only the JSON object for the next parameter set.')
  return lines.join('\n')
}

/** Run one generation call against one fallback target. */
async function generateOnce(
  ctx: Context,
  target: ModelTarget,
  context: GenerationContext,
  resolved: ResolvedConfig,
  sessionId: GenerateOptions['sessionId'],
): Promise<{ params: SpecLoopParams; usage: TokenUsage | undefined }> {
  const assembler = new BlockAssembler()
  const options: GenerateOptions = {
    provider: target.provider,
    model: target.model,
    system: GENERATION_SYSTEM,
    messages: [createUserMessage({
      content: [{ type: 'text', text: buildGenerationPrompt(context, resolved) }],
      source: { kind: 'plugin', plugin: 'dsh-tool-spec-loop' },
    })],
    maxTokens: resolved.maxGenerationTokens,
    ...sessionId === undefined ? {} : { sessionId },
    ...context.signal === undefined ? {} : { signal: context.signal },
  }
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  const error = finishError(assembler.finish)
  if (error !== undefined) throw error
  const params = parseParams(textOf(assembler.blocks()))
  if (params === undefined) {
    throw new Error(`model ${target.model} returned no parseable JSON parameter object`)
  }
  return { params, usage: assembler.usage }
}

/** Render any thrown value without letting the render itself throw. */
function renderError(error: unknown): string {
  try {
    return String(error instanceof Error ? error.message : error)
  } catch {
    return '[unrenderable thrown value]'
  }
}

/** The multi-model-fallback generator: each proposal tries every target in order. */
function createGenerator(
  ctx: Context,
  resolved: ResolvedConfig,
  sessionId: GenerateOptions['sessionId'],
): SpecLoopGenerator {
  return {
    async generate(context: GenerationContext): Promise<Generation> {
      let lastError: unknown
      for (const target of resolved.models) {
        try {
          const { params, usage } = await generateOnce(ctx, target, context, resolved, sessionId)
          return { params, model: target, ...usage === undefined ? {} : { usage } }
        } catch (error) {
          lastError = error
        }
      }
      throw new Error(
        `spec-loop generation failed on every configured model (${resolved.models.length}): ${renderError(lastError)}`,
      )
    },
  }
}

/** Fail loud when a spec budget exceeds its deployment ceiling. */
function assertCeilings(spec: SpecLoopSpec, resolved: ResolvedConfig): void {
  if (spec.budgets.maxIterations > resolved.maxIterations) {
    throw new SpecLoopError(
      `spec budgets.maxIterations ${spec.budgets.maxIterations} exceeds the deployment ceiling ${resolved.maxIterations}`,
      'INVALID_SPEC',
    )
  }
  if (spec.budgets.maxWallClockMs !== undefined && spec.budgets.maxWallClockMs > resolved.maxWallClockMs) {
    throw new SpecLoopError(
      `spec budgets.maxWallClockMs ${spec.budgets.maxWallClockMs} exceeds the deployment ceiling ${resolved.maxWallClockMs}`,
      'INVALID_SPEC',
    )
  }
  if (spec.budgets.maxTokens !== undefined && spec.budgets.maxTokens > resolved.maxTokens) {
    throw new SpecLoopError(
      `spec budgets.maxTokens ${spec.budgets.maxTokens} exceeds the deployment ceiling ${resolved.maxTokens}`,
      'INVALID_SPEC',
    )
  }
}

/** Per-class failure counts for the canonical result. */
function countFailures(iterations: readonly IterationRecord[]): Record<string, number> {
  let s0 = 0
  let s1 = 0
  let s2 = 0
  let s3 = 0
  let generationFailed = 0
  for (const record of iterations) {
    switch (record.verdict) {
      case 'S0': s0 += 1; break
      case 'S1': s1 += 1; break
      case 'S2': s2 += 1; break
      case 'S3': s3 += 1; break
      case 'generation-failed': generationFailed += 1; break
      case 'satisfied':
      case 'cancelled':
        break
    }
  }
  return { S0: s0, S1: s1, S2: s2, S3: s3, generationFailed }
}

/** Format one wire scalar for the report; anything else reads as unknown. */
function renderScalar(value: unknown): string {
  return typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean'
    ? String(value)
    : 'unknown'
}

/** Human-readable terminal summary, bounded by the config cap. */
function renderReport(value: JsonValue, specRaw: JsonValue, maxChars: number): string {
  if (!isRecord(value)) return 'Spec loop finished; report unavailable.'
  const runId = typeof value['runId'] === 'string' ? value['runId'] : ''
  const status = typeof value['status'] === 'string' ? value['status'] : 'unknown'
  const iterations = Array.isArray(value['iterations']) ? value['iterations'] : []
  const specId = isRecord(specRaw) && typeof specRaw['id'] === 'string' ? specRaw['id'] : ''
  const objective = isRecord(specRaw) && isRecord(specRaw['objective']) ? specRaw['objective'] : {}
  const objectivePath = typeof objective['path'] === 'string' ? objective['path'] : ''
  const direction = objective['direction'] === 'minimize' || objective['direction'] === 'maximize'
    ? objective['direction']
    : ''

  let bestText: string | undefined
  for (let index = iterations.length - 1; index >= 0; index -= 1) {
    const record = iterations[index]
    if (isRecord(record)
      && record['accepted'] === true
      && isRecord(record['params'])
      && typeof record['objective'] === 'number') {
      bestText = `Best accepted: ${objectivePath} = ${String(record['objective'])}${direction === '' ? '' : ` (${direction})`} — params ${JSON.stringify(record['params'])}`
      break
    }
  }

  const costs = isRecord(value['costs']) ? value['costs'] : {}
  const lines = [
    `Spec loop ${runId} for spec ${specId} ended with status ${status} after ${iterations.length} iteration${iterations.length === 1 ? '' : 's'}.`,
  ]
  if (bestText !== undefined) lines.push(bestText)
  lines.push(`Costs: ${renderScalar(costs['wallClockMs'])} ms wall clock, ${renderScalar(costs['licenseMs'])} ms license, ${renderScalar(costs['iterations'])} iterations.`)
  if (isRecord(costs['tokens'])) {
    lines.push(`Tokens: ${renderScalar(costs['tokens']['inputTokens'])} input, ${renderScalar(costs['tokens']['outputTokens'])} output.`)
  }
  return truncateText(lines.join('\n'), maxChars)
}

/** Read one string field from a JSON record for the pending card. */
function readStringField(value: JsonValue, field: string): string | undefined {
  if (!isRecord(value)) return undefined
  const read = value[field]
  return typeof read === 'string' ? read : undefined
}

/** Read the assertion count from a JSON record for the pending card. */
function readAssertionCount(value: JsonValue): number {
  if (!isRecord(value)) return 0
  return Array.isArray(value['assertions']) ? value['assertions'].length : 0
}

interface SpecLoopCallArgs {
  spec: JsonValue
  initialParams?: JsonValue
}

function presentCall(args: SpecLoopCallArgs): ToolCallView {
  return {
    card: 'generic',
    title: 'spec-loop',
    kind: 'other',
    rawInput: {
      specId: readStringField(args.spec, 'id') ?? '',
      assertions: readAssertionCount(args.spec),
      objective: JSON.stringify(isRecord(args.spec) ? args.spec['objective'] : undefined),
      hasInitialParams: args.initialParams !== undefined,
    },
  }
}

function presentResult(_args: SpecLoopCallArgs, _result: { content: ContentBlock[]; isError: boolean }): ToolResultView {
  return { card: 'generic' }
}

/** Register the spec_loop tool and its usage-policy prompt section. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  ctx.systemPrompt.section({
    name: 'tool:spec-loop',
    order: 114,
    text: SECTION_TEXT,
  })
  ctx.tools.register(defineTool({
    name: 'spec_loop',
    description: DESCRIPTION,
    parameters: {
      spec: {
        type: 'json',
        required: true,
        description: 'The full spec contract: { id, objective: { path, direction: "minimize"|"maximize" }, assertions: [{ id, path, predicate: "lte"|"gte"|"between", target }], budgets: { maxIterations, maxWallClockMs?, maxTokens? }, repair: { margin, maxNoImprovement, maxConsecutiveInfrastructure? }, envelope?: { bounds: { [path]: { min, max } } }, description? }.',
      },
      initialParams: {
        type: 'json',
        description: 'Optional starting parameter set evaluated before any generation.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', required: true },
          status: {
            type: 'string',
            required: true,
            enum: ['satisfied', 'budget-limited', 'no-improvement', 'infrastructure-failed', 'failed', 'cancelled'],
          },
          iterations: { type: 'json', required: true },
          best: { type: 'json' },
          costs: { type: 'json', required: true },
          failures: { type: 'json', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: renderReport(value, args.spec, resolved.maxResultChars),
      }],
    },
    async execute(args, exec) {
      const spec = validateSpec(args.spec)
      assertCeilings(spec, resolved)
      const adapter = ctx.get('specLoopAdapter')
      if (adapter === undefined) {
        throw new Error('spec_loop requires a registered specLoopAdapter service (no provider mounted)')
      }
      let initialParams: SpecLoopParams | undefined
      if (args.initialParams !== undefined) {
        if (args.initialParams === null || typeof args.initialParams !== 'object' || Array.isArray(args.initialParams)) {
          throw new Error('spec_loop initialParams must be a JSON object')
        }
        initialParams = args.initialParams
      }
      const sessionId = exec.agent === undefined ? undefined : exec.agent.session.id
      const generator = createGenerator(ctx, resolved, sessionId)
      const report = await runSpecLoop({
        runId: SpecLoopRunId(randomUUID()),
        spec,
        generator,
        adapter,
        ...initialParams === undefined ? {} : { initialParams },
        ceilings: {
          maxIterations: resolved.maxIterations,
          maxWallClockMs: resolved.maxWallClockMs,
          maxTokens: resolved.maxTokens,
        },
        signal: exec.signal,
      })
      return {
        runId: report.runId,
        status: report.status,
        iterations: report.iterations as unknown as JsonValue,
        ...report.best === null ? {} : { best: report.best as unknown as JsonValue },
        costs: report.costs as unknown as JsonValue,
        failures: countFailures(report.iterations) as unknown as JsonValue,
      }
    },
    presentCall,
    presentResult,
  }))
}
