import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SpecLoopAdapterService } from '@deepseek-ai/dsh-spec-loop'
import type { AdapterRunOutcome, AdapterRunRequest, ValidationOutcome } from '@deepseek-ai/dsh-spec-loop'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as ToolSpecLoop from '../src/index.ts'

const SPEC = {
  id: 'beam-demo',
  objective: { path: 'stress_MPa', direction: 'minimize' },
  assertions: [{ id: 'cap', path: 'stress_MPa', predicate: 'lte', target: 400 }],
  budgets: { maxIterations: 8 },
  repair: { margin: 1, maxNoImprovement: 3 },
}

/** Deterministic in-process adapter: thickness 6 passes, everything else fails. */
class FakeAdapterService extends SpecLoopAdapterService {
  async validate(): Promise<ValidationOutcome> {
    return { ok: true, reasons: [] }
  }

  async run(request: AdapterRunRequest): Promise<AdapterRunOutcome> {
    const thickness = request.params['thickness']
    return { status: 'success', result: { stress_MPa: thickness === 6 ? 300 : 500 } }
  }
}

describe('dsh-tool-spec-loop over the real agent stack', () => {
  it('drives the full loop through the LLM seam and the mounted adapter under a live agent', async () => {
    const ctx = new Context()
    const adapter = new MockAdapter([
      textResponse('{"thickness": 3}'),
      textResponse('{"thickness": 6}'),
    ])
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(FakeAdapterService)
    await ctx.plugin(ToolSpecLoop, { models: [{ provider: 'mock', model: 'mock' }] })
    ctx.llm.registerAdapter(['mock'], adapter)
    const parentHandle = await ctx.agents.create({
      sessionId: SessionId('spec-loop-parent'),
      meta: { cwd: '/tmp/spec-loop-workspace' },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const parent = parentHandle.agent

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('spec-loop-integration'),
      name: 'spec_loop',
      arguments: { spec: SPEC },
      agent: parent,
    })

    expect(result.isError).toBe(false)
    const value = result.value as { status: string; iterations: Array<Record<string, unknown>> }
    expect(value.status).toBe('satisfied')
    expect(value.iterations).toHaveLength(2)
    expect(value.iterations[0]).toMatchObject({ verdict: 'S0', objective: 500 })
    expect(value.iterations[1]).toMatchObject({ verdict: 'satisfied', objective: 300, accepted: true })
    expect((result.content[0] as { text: string }).text).toContain('ended with status satisfied after 2 iterations')

    expect(adapter.requests).toHaveLength(2)
    await parentHandle.dispose()
  })
})
