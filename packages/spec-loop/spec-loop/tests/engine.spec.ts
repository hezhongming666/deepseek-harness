import { afterEach, describe, expect, it, vi } from 'vitest'
import { SpecLoopRunId, runSpecLoop, validateSpec } from '../src/index.ts'
import type {
  AdapterRunOutcome,
  Generation,
  SpecLoopAdapter,
  SpecLoopGenerator,
  SpecLoopParams,
  SpecLoopReport,
  SpecLoopSpec,
  ValidationOutcome,
} from '../src/index.ts'

function spec(overrides: Record<string, unknown> = {}): SpecLoopSpec {
  return validateSpec({
    id: 'demo-spec',
    objective: { path: 'stress_MPa', direction: 'minimize' },
    assertions: [{ id: 'cap', path: 'stress_MPa', predicate: 'lte', target: 400 }],
    budgets: { maxIterations: 10 },
    repair: { margin: 1, maxNoImprovement: 3 },
    ...overrides,
  })
}

/** Scripted adapter: deterministic per-param responses, call records kept. */
class FakeAdapter implements SpecLoopAdapter {
  readonly validateCalls: SpecLoopParams[] = []
  readonly runCalls: SpecLoopParams[] = []
  validation: (params: SpecLoopParams) => ValidationOutcome = () => ({ ok: true, reasons: [] })
  runHandler: (params: SpecLoopParams) => AdapterRunOutcome = params => ({
    status: 'success',
    result: { stress_MPa: params['stress_MPa'] ?? 0 },
  })
  licenseMs = 0

  async validate(params: SpecLoopParams): Promise<ValidationOutcome> {
    this.validateCalls.push(params)
    return this.validation(params)
  }

  async run(request: { params: SpecLoopParams }): Promise<AdapterRunOutcome> {
    this.runCalls.push(request.params)
    const outcome = this.runHandler(request.params)
    return { ...outcome, ...this.licenseMs === 0 ? {} : { licenseMs: this.licenseMs } }
  }
}

/** Scripted generator: one proposal per call; throws once the queue is empty. */
function scriptedGenerator(...proposals: Generation[]): SpecLoopGenerator {
  const queue = [...proposals]
  return {
    async generate() {
      const next = queue.shift()
      if (next === undefined) throw new Error('script exhausted')
      return next
    },
  }
}

function proposal(params: SpecLoopParams, usage?: Generation['usage']): Generation {
  return { params, model: { provider: 'mock', model: 'mock' }, ...usage === undefined ? {} : { usage } }
}

const RUN_ID = () => SpecLoopRunId('run-1')

/** Strip wall-clock timing so determinism of bookkeeping can be asserted. */
function withoutTiming(report: SpecLoopReport): SpecLoopReport {
  return {
    ...report,
    iterations: report.iterations.map(record => ({ ...record, wallClockMs: 0 })),
    costs: { ...report.costs, wallClockMs: 0 },
  }
}

async function run(request: {
  spec?: SpecLoopSpec
  generator?: SpecLoopGenerator
  adapter?: FakeAdapter
  initialParams?: SpecLoopParams
  ceilings?: { maxIterations?: number; maxWallClockMs?: number; maxTokens?: number }
  signal?: AbortSignal
}): Promise<SpecLoopReport> {
  return runSpecLoop({
    runId: RUN_ID(),
    spec: request.spec ?? spec(),
    generator: request.generator ?? scriptedGenerator(),
    adapter: request.adapter ?? new FakeAdapter(),
    ...request.initialParams === undefined ? {} : { initialParams: request.initialParams },
    ...request.ceilings === undefined ? {} : { ceilings: request.ceilings },
    ...request.signal === undefined ? {} : { signal: request.signal },
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('runSpecLoop terminal outcomes', () => {
  it('accepts an initial candidate that satisfies every assertion without generating', async () => {
    const adapter = new FakeAdapter()
    const report = await run({ adapter, initialParams: { stress_MPa: 300 } })
    expect(report.status).toBe('satisfied')
    expect(report.iterations).toHaveLength(1)
    expect(report.iterations[0]).toMatchObject({
      iteration: 1,
      verdict: 'satisfied',
      runStatus: 'success',
      objective: 300,
      accepted: true,
    })
    expect(report.iterations[0]?.model).toBeUndefined()
    expect(report.best).toEqual({ params: { stress_MPa: 300 }, objective: 300 })
    expect(report.costs.iterations).toBe(1)
    expect(report.costs.tokens).toEqual({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    })
    expect(adapter.validateCalls).toEqual([{ stress_MPa: 300 }])
    expect(adapter.runCalls).toEqual([{ stress_MPa: 300 }])
  })

  it('repairs one S0 failure and satisfies on the next proposal', async () => {
    const adapter = new FakeAdapter()
    const report = await run({
      adapter,
      initialParams: { stress_MPa: 500 },
      generator: scriptedGenerator(proposal({ stress_MPa: 300 })),
    })
    expect(report.status).toBe('satisfied')
    expect(report.iterations.map(record => record.verdict)).toEqual(['S0', 'satisfied'])
    expect(report.iterations[0]).toMatchObject({
      verdict: 'S0',
      objective: 500,
      accepted: true,
      assertionResults: [{ id: 'cap', passed: false, actual: 500 }],
    })
    expect(report.iterations[1]).toMatchObject({ verdict: 'satisfied', objective: 300, accepted: true })
    expect(report.best).toEqual({ params: { stress_MPa: 300 }, objective: 300 })
  })

  it('tracks monotonic best with the epsilon margin and stops after N non-improvements', async () => {
    const report = await run({
      initialParams: { stress_MPa: 500 },
      generator: scriptedGenerator(
        proposal({ stress_MPa: 499 }),
        proposal({ stress_MPa: 498.5 }),
        proposal({ stress_MPa: 498.6 }),
        proposal({ stress_MPa: 498.7 }),
      ),
    })
    expect(report.status).toBe('no-improvement')
    expect(report.iterations).toHaveLength(5)
    expect(report.iterations.map(record => record.accepted)).toEqual([true, true, false, false, false])
    expect(report.best).toEqual({ params: { stress_MPa: 499 }, objective: 499 })
  })

  it('classifies S1 validation refusals and never runs refused candidates', async () => {
    const adapter = new FakeAdapter()
    adapter.validation = params => params['stress_MPa'] === 500
      ? { ok: false, reasons: ['stress above the feasible range'] }
      : { ok: true, reasons: [] }
    const report = await run({
      adapter,
      initialParams: { stress_MPa: 500 },
      generator: scriptedGenerator(proposal({ stress_MPa: 300 })),
    })
    expect(report.status).toBe('satisfied')
    expect(report.iterations[0]).toMatchObject({
      verdict: 'S1',
      validation: { ok: false, reasons: ['stress above the feasible range'] },
    })
    expect(report.iterations[0]?.runStatus).toBeUndefined()
    expect(adapter.runCalls).toEqual([{ stress_MPa: 300 }])
  })

  it('rejects envelope violations before validation with an S1 reason', async () => {
    const adapter = new FakeAdapter()
    const envelopeSpec = spec({ envelope: { bounds: { stress_MPa: { min: 0, max: 450 } } } })
    const report = await run({
      spec: envelopeSpec,
      adapter,
      initialParams: { stress_MPa: 500 },
      generator: scriptedGenerator(proposal({ stress_MPa: 300 })),
    })
    expect(report.status).toBe('satisfied')
    expect(report.iterations[0]).toMatchObject({ verdict: 'S1' })
    expect(report.iterations[0]?.validation?.reasons).toEqual(['envelope: stress_MPa = 500 outside [0, 450]'])
    expect(adapter.validateCalls).toEqual([{ stress_MPa: 300 }])
  })

  it('classifies divergence as S2 and continues without touching the infrastructure counter', async () => {
    const adapter = new FakeAdapter()
    adapter.runHandler = params => params['stress_MPa'] === 500
      ? { status: 'diverged', error: 'residual rising at iteration 347' }
      : { status: 'success', result: { stress_MPa: 300 } }
    const report = await run({
      adapter,
      initialParams: { stress_MPa: 500 },
      generator: scriptedGenerator(proposal({ stress_MPa: 300 })),
    })
    expect(report.status).toBe('satisfied')
    expect(report.iterations[0]).toMatchObject({
      verdict: 'S2',
      runStatus: 'diverged',
      error: 'residual rising at iteration 347',
    })
  })

  it('stops with infrastructure-failed after consecutive S3 iterations', async () => {
    const adapter = new FakeAdapter()
    adapter.runHandler = () => ({ status: 'infrastructure', error: 'solver crashed' })
    const report = await run({
      adapter,
      generator: scriptedGenerator(
        proposal({ stress_MPa: 1 }),
        proposal({ stress_MPa: 2 }),
        proposal({ stress_MPa: 3 }),
        proposal({ stress_MPa: 4 }),
      ),
    })
    expect(report.status).toBe('infrastructure-failed')
    expect(report.iterations).toHaveLength(3)
    expect(report.iterations.map(record => record.verdict)).toEqual(['S3', 'S3', 'S3'])
  })

  it('classifies thrown adapter failures as S3', async () => {
    const adapter = new FakeAdapter()
    adapter.validation = () => { throw new Error('license server unreachable') }
    const validationReport = await run({
      spec: spec({ repair: { margin: 1, maxNoImprovement: 3, maxConsecutiveInfrastructure: 2 } }),
      adapter,
      generator: scriptedGenerator(proposal({ stress_MPa: 1 }), proposal({ stress_MPa: 2 })),
    })
    expect(validationReport.status).toBe('infrastructure-failed')
    expect(validationReport.iterations.map(record => record.verdict)).toEqual(['S3', 'S3'])
    expect(validationReport.iterations[0]?.error).toBe('adapter validation failed: license server unreachable')

    const runAdapter = new FakeAdapter()
    runAdapter.runHandler = () => { throw new Error('process died') }
    const runReport = await run({
      spec: spec({ repair: { margin: 1, maxNoImprovement: 3, maxConsecutiveInfrastructure: 2 } }),
      adapter: runAdapter,
      generator: scriptedGenerator(proposal({ stress_MPa: 1 }), proposal({ stress_MPa: 2 })),
    })
    expect(runReport.status).toBe('infrastructure-failed')
    expect(runReport.iterations.map(record => record.verdict)).toEqual(['S3', 'S3'])
    expect(runReport.iterations[0]?.error).toBe('adapter run failed: process died')
  })

  it('stops with failed and a generation-failed record when every fallback is exhausted', async () => {
    const report = await run({
      generator: {
        async generate() {
          throw new Error('all fallback models failed')
        },
      },
    })
    expect(report.status).toBe('failed')
    expect(report.iterations).toMatchObject([{
      iteration: 1,
      verdict: 'generation-failed',
      error: 'all fallback models failed',
    }])
  })

  it('classifies a killed adapter run as cancelled', async () => {
    const adapter = new FakeAdapter()
    adapter.runHandler = () => ({ status: 'killed', error: 'aborted' })
    const report = await run({ adapter, initialParams: { stress_MPa: 300 } })
    expect(report.status).toBe('cancelled')
    expect(report.iterations[0]).toMatchObject({ verdict: 'cancelled', runStatus: 'killed' })
  })

  it('reports an S0 with a diagnosis when the objective metric is missing', async () => {
    const adapter = new FakeAdapter()
    adapter.runHandler = () => ({ status: 'success', result: { other_field: 1 } })
    const report = await run({
      adapter,
      initialParams: { stress_MPa: 300 },
      generator: scriptedGenerator(proposal({ stress_MPa: 100 })),
    })
    expect(report.status).toBe('failed')
    expect(report.iterations).toHaveLength(3)
    expect(report.iterations[0]).toMatchObject({ verdict: 'S0' })
    expect(report.iterations[0]?.error).toContain('objective metric "stress_MPa" missing')
    expect(report.iterations[1]?.verdict).toBe('S0')
    expect(report.iterations[2]?.verdict).toBe('generation-failed')
  })
})

describe('runSpecLoop budgets and cancellation', () => {
  it('stops budget-limited at the iteration cap', async () => {
    const report = await run({
      spec: spec({ repair: { margin: 0, maxNoImprovement: 100 }, budgets: { maxIterations: 2 } }),
      generator: scriptedGenerator(proposal({ stress_MPa: 500 }), proposal({ stress_MPa: 500 })),
    })
    expect(report.status).toBe('budget-limited')
    expect(report.iterations).toHaveLength(2)
  })

  it('tightens the iteration cap with the deployment ceiling', async () => {
    const report = await run({
      spec: spec({ repair: { margin: 0, maxNoImprovement: 100 }, budgets: { maxIterations: 10 } }),
      ceilings: { maxIterations: 2 },
      generator: scriptedGenerator(proposal({ stress_MPa: 500 }), proposal({ stress_MPa: 500 })),
    })
    expect(report.status).toBe('budget-limited')
    expect(report.iterations).toHaveLength(2)
  })

  it('stops budget-limited when the billed token budget is spent', async () => {
    const usage = { inputTokens: 60, outputTokens: 40 }
    const report = await run({
      spec: spec({ budgets: { maxIterations: 10, maxTokens: 100 } }),
      generator: scriptedGenerator(proposal({ stress_MPa: 500 }, usage), proposal({ stress_MPa: 500 }, usage)),
    })
    expect(report.status).toBe('budget-limited')
    expect(report.iterations).toHaveLength(1)
    expect(report.costs.tokens).toEqual({
      inputTokens: 60, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    })
  })

  it('stops budget-limited when the wall-clock budget is spent', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const generator = scriptedGenerator(proposal({ stress_MPa: 499 }))
    const originalGenerate = generator.generate.bind(generator)
    generator.generate = async (context) => {
      vi.advanceTimersByTime(1000)
      return originalGenerate(context)
    }
    const report = await run({
      spec: spec({ budgets: { maxIterations: 10, maxWallClockMs: 500 } }),
      generator,
      initialParams: { stress_MPa: 500 },
    })
    expect(report.status).toBe('budget-limited')
    expect(report.iterations).toHaveLength(2)
  })

  it('returns cancelled immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const report = await run({ signal: controller.signal })
    expect(report.status).toBe('cancelled')
    expect(report.iterations).toHaveLength(0)
  })

  it('sums license time and token usage into the cost report', async () => {
    const adapter = new FakeAdapter()
    adapter.licenseMs = 25
    const usage = { inputTokens: 10, outputTokens: 5 }
    const report = await run({
      adapter,
      initialParams: { stress_MPa: 500 },
      generator: scriptedGenerator(proposal({ stress_MPa: 300 }, usage)),
    })
    expect(report.status).toBe('satisfied')
    expect(report.costs.licenseMs).toBe(50)
    expect(report.costs.tokens.inputTokens).toBe(10)
    expect(report.costs.tokens.outputTokens).toBe(5)
  })
})

describe('runSpecLoop determinism', () => {
  it('produces identical bookkeeping for the same generation and adapter outcome sequence', async () => {
    const sequence = () => ({
      adapter: new FakeAdapter(),
      generator: scriptedGenerator(
        proposal({ stress_MPa: 499 }),
        proposal({ stress_MPa: 498 }),
        proposal({ stress_MPa: 300 }),
      ),
      initialParams: { stress_MPa: 500 },
    })
    const first = await run(sequence())
    const second = await run(sequence())
    expect(withoutTiming(first)).toEqual(withoutTiming(second))
    expect(first.status).toBe('satisfied')
    expect(first.best).toEqual({ params: { stress_MPa: 300 }, objective: 300 })
  })
})
