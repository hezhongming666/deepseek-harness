import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SpecLoopAdapterService } from '@deepseek-ai/dsh-spec-loop'
import type { AdapterRunOutcome, AdapterRunRequest, SpecLoopParams, ValidationOutcome } from '@deepseek-ai/dsh-spec-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as ToolSpecLoop from '../src/index.ts'
import type { Config } from '../src/index.ts'

const SPEC = {
  id: 'beam-demo',
  objective: { path: 'stress_MPa', direction: 'minimize' },
  assertions: [{ id: 'cap', path: 'stress_MPa', predicate: 'lte', target: 400 }],
  budgets: { maxIterations: 8 },
  repair: { margin: 1, maxNoImprovement: 3 },
}

/** Deterministic in-process adapter: thickness 6 passes, everything else fails. */
class FakeAdapterService extends SpecLoopAdapterService {
  runHandler: (params: SpecLoopParams) => AdapterRunOutcome = params => ({
    status: 'success',
    result: { stress_MPa: params['thickness'] === 6 ? 300 : 500 },
  })

  async validate(): Promise<ValidationOutcome> {
    return { ok: true, reasons: [] }
  }

  async run(request: AdapterRunRequest): Promise<AdapterRunOutcome> {
    return this.runHandler(request.params)
  }
}

const DEFAULT_CONFIG: Config = { models: [{ provider: 'mock', model: 'mock' }] }

async function mount(config: Partial<Config> = {}, withAdapter = true): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(LlmRuntime)
  if (withAdapter) await ctx.plugin(FakeAdapterService)
  await ctx.plugin(ToolSpecLoop, Object.assign({}, DEFAULT_CONFIG, config))
  return ctx
}

function execute(ctx: Context, args: { spec: unknown; initialParams?: unknown }) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId('spec-loop-test'),
    name: 'spec_loop',
    arguments: args,
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** One provider error finish chunk for scripting a failing route. */
const errorChunks: StreamChunk[] = [{
  type: 'finish',
  reason: { kind: 'error', failure: { message: 'route down', code: 'PROVIDER' } },
}]

describe('dsh-tool-spec-loop registration and config', () => {
  it('registers the spec_loop tool with its schema and description', async () => {
    const ctx = await mount()
    const schema = ctx.tools.schemas().find(entry => entry.name === 'spec_loop')
    expect(schema).toBeDefined()
    expect(schema?.description).toContain('deterministic spec loop')
  })

  it('rejects empty and malformed model chains at apply time', async () => {
    const ctx = new Context()
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(LlmRuntime)
    await expect(ctx.plugin(ToolSpecLoop, { models: [] })).rejects.toThrow('non-empty models fallback chain')
    await expect(ctx.plugin(ToolSpecLoop, { models: [{ provider: ' ', model: 'm' }] })).rejects.toThrow('providers must be non-empty strings')
    await expect(ctx.plugin(ToolSpecLoop, { models: [{ provider: 'p', model: '' }] })).rejects.toThrow('model ids must be non-empty strings')
  })

  it('disposing the owning fiber unregisters the tool', async () => {
    const ctx = new Context()
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(LlmRuntime)
    const fiber = await ctx.plugin(ToolSpecLoop, DEFAULT_CONFIG)
    expect(ctx.tools.schemas().some(entry => entry.name === 'spec_loop')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(entry => entry.name === 'spec_loop')).toBe(false)
  })
})

describe('dsh-tool-spec-loop execution', () => {
  it('fails loud when no adapter service is mounted', async () => {
    const ctx = await mount({}, false)
    const result = await execute(ctx, { spec: SPEC, initialParams: { thickness: 6 } })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('requires a registered specLoopAdapter service')
  })

  it('rejects spec budgets that exceed the deployment ceilings', async () => {
    const ctx = await mount({ maxIterations: 2 })
    const result = await execute(ctx, {
      spec: { ...SPEC, budgets: { maxIterations: 4 } },
      initialParams: { thickness: 6 },
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('exceeds the deployment ceiling')
  })

  it('rejects a non-object initialParams', async () => {
    const ctx = await mount()
    const result = await execute(ctx, { spec: SPEC, initialParams: 42 })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('initialParams must be a JSON object')
  })

  it('completes a no-generation run from satisfying initial params', async () => {
    const ctx = await mount()
    const result = await execute(ctx, { spec: SPEC, initialParams: { thickness: 6 } })
    expect(result.isError).toBe(false)
    const value = result.value as {
      runId: string
      status: string
      iterations: unknown[]
      costs: Record<string, unknown>
      failures: Record<string, number>
    }
    expect(value.status).toBe('satisfied')
    expect(value.iterations).toHaveLength(1)
    expect(value.failures).toEqual({ S0: 0, S1: 0, S2: 0, S3: 0, generationFailed: 0 })
    expect(value.costs['iterations']).toBe(1)
    expect(text(result)).toContain('ended with status satisfied after 1 iteration')
    expect(text(result)).toContain('Best accepted: stress_MPa = 300 (minimize)')
  })

  it('runs the full generation loop through the mock LLM and repairs one S0', async () => {
    const ctx = new Context()
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(FakeAdapterService)
    await ctx.plugin(LlmRuntime)
    const adapter = new MockAdapter([
      textResponse('{"thickness": 3}'),
      textResponse('```json\n{"thickness": 6}\n```'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    await ctx.plugin(ToolSpecLoop, DEFAULT_CONFIG)

    const result = await execute(ctx, { spec: SPEC, initialParams: { thickness: 2 } })
    expect(result.isError).toBe(false)
    const value = result.value as { status: string; iterations: Array<Record<string, unknown>>; failures: Record<string, number> }
    expect(value.status).toBe('satisfied')
    expect(value.iterations).toHaveLength(3)
    expect(value.iterations[0]?.['verdict']).toBe('S0')
    expect(value.iterations[1]).toMatchObject({
      verdict: 'S0',
      model: { provider: 'mock', model: 'mock' },
      objective: 500,
    })
    expect(value.iterations[2]).toMatchObject({
      verdict: 'satisfied',
      objective: 300,
      accepted: true,
    })
    expect(value.failures).toEqual({ S0: 2, S1: 0, S2: 0, S3: 0, generationFailed: 0 })

    const requestText = JSON.stringify(adapter.requests)
    expect(requestText).toContain('Propose candidate parameters for spec')
    expect(requestText).toContain('You propose parameter sets for a deterministic spec loop')
  })

  it('falls back to the next model when an earlier route fails', async () => {
    const ctx = new Context()
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(FakeAdapterService)
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['mock'], new MockAdapter([errorChunks]))
    ctx.llm.registerAdapter(['mock2'], new MockAdapter([textResponse('{"thickness": 6}')]))
    await ctx.plugin(ToolSpecLoop, {
      models: [{ provider: 'mock', model: 'failing' }, { provider: 'mock2', model: 'ok' }],
    })

    const result = await execute(ctx, { spec: SPEC })
    expect(result.isError).toBe(false)
    const value = result.value as { status: string; iterations: Array<Record<string, unknown>> }
    expect(value.status).toBe('satisfied')
    expect(value.iterations).toHaveLength(1)
    expect(value.iterations[0]).toMatchObject({
      verdict: 'satisfied',
      model: { provider: 'mock2', model: 'ok' },
    })
  })

  it('returns a failed report when every fallback model fails', async () => {
    const ctx = new Context()
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(FakeAdapterService)
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['mock'], new MockAdapter([errorChunks]))
    ctx.llm.registerAdapter(['mock2'], new MockAdapter([errorChunks]))
    await ctx.plugin(ToolSpecLoop, {
      models: [{ provider: 'mock', model: 'failing' }, { provider: 'mock2', model: 'also-failing' }],
    })

    const result = await execute(ctx, { spec: SPEC })
    expect(result.isError).toBe(false)
    const value = result.value as { status: string; iterations: Array<Record<string, unknown>>; failures: Record<string, number> }
    expect(value.status).toBe('failed')
    expect(value.iterations).toHaveLength(1)
    expect(value.iterations[0]).toMatchObject({ verdict: 'generation-failed' })
    expect(value.failures).toEqual({ S0: 0, S1: 0, S2: 0, S3: 0, generationFailed: 1 })
  })
})
