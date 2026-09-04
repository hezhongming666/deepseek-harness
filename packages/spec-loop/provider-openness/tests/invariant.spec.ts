import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as ProviderOpennessInvariant from '../src/invariant.ts'
import OpennessSpecLoopAdapter from '../src/index.ts'

/** Full schema-input config: the schema's input type is the complete Config. */
function urlConfig(url: string): ReturnType<typeof OpennessSpecLoopAdapter.Config> {
  return OpennessSpecLoopAdapter.Config({
    url,
    spawn: { command: '', args: [], cwd: '', port: 0, readyTimeoutMs: 30_000 },
    requestTimeoutMs: 300_000,
  })
}

describe('provider-openness invariants', () => {
  it('mounts beside the registry and disposes cleanly', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(ProviderOpennessInvariant)
    await ctx.fiber.dispose()
  })

  it('returns a disposer without throwing while the reservation stands', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const dispose = await ProviderOpennessInvariant.apply(ctx)
    expect(() => ProviderOpennessInvariant.apply(ctx)).toThrow(/already registered/)
    expect(() => { dispose() }).not.toThrow()
    await ctx.fiber.dispose()
  })

  it('composes the companion beside a url-mode adapter registration', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(ProviderOpennessInvariant)
    new OpennessSpecLoopAdapter(ctx, urlConfig('http://127.0.0.1:4279'))
    expect(ctx.get('specLoopAdapter')).toBeInstanceOf(OpennessSpecLoopAdapter)
    await ctx.fiber.dispose()
  })
})
