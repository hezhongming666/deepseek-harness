import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import OpennessSpecLoopAdapter, { resolveConfig } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { startFakeBridge } from './fake-bridge.ts'
import type { FakeBridge } from './fake-bridge.ts'
import { fakeSpawnFactory } from './fake-spawn.ts'

const open: FakeBridge[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map(bridge => bridge.close()))
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/**
 * Build a full schema-input config: the Schemastery schema's input type is the
 * complete `Config`, with defaults applied by the schema call itself.
 */
function configOf(partial: Partial<Config> = {}): Config {
  return {
    url: partial.url ?? '',
    spawn: {
      command: partial.spawn?.command ?? '',
      args: partial.spawn?.args ?? [],
      cwd: partial.spawn?.cwd ?? '',
      port: partial.spawn?.port ?? 0,
      readyTimeoutMs: partial.spawn?.readyTimeoutMs ?? 30_000,
    },
    requestTimeoutMs: partial.requestTimeoutMs ?? 300_000,
  }
}

/** Build a url-mode adapter over one fake bridge. */
async function urlAdapter(): Promise<{
  ctx: Context
  adapter: OpennessSpecLoopAdapter
  bridge: FakeBridge
}> {
  const bridge = await startFakeBridge()
  open.push(bridge)
  const ctx = new Context()
  contexts.push(ctx)
  const config = OpennessSpecLoopAdapter.Config(configOf({
    url: bridge.baseUrl,
    requestTimeoutMs: 5000,
  }))
  const adapter = new OpennessSpecLoopAdapter(ctx, config)
  return { ctx, adapter, bridge }
}

describe('resolveConfig', () => {
  const base = {
    url: '',
    spawn: { command: '', args: [], cwd: '', port: 0, readyTimeoutMs: 1000 },
    requestTimeoutMs: 5000,
  }

  it('resolves url mode with a trailing-slash-stripped base URL', () => {
    expect(resolveConfig({ ...base, url: 'http://127.0.0.1:4279/' }))
      .toEqual({ kind: 'url', baseUrl: 'http://127.0.0.1:4279', requestTimeoutMs: 5000 })
  })

  it('resolves spawn mode', () => {
    expect(resolveConfig({ ...base, spawn: { command: 'dotnet', args: ['b.dll'], cwd: 'C:\\b', port: 4279, readyTimeoutMs: 1000 } }))
      .toEqual({
        kind: 'spawn',
        spawn: { command: 'dotnet', args: ['b.dll'], cwd: 'C:\\b', port: 4279, readyTimeoutMs: 1000 },
        requestTimeoutMs: 5000,
      })
  })

  it.each([
    ['neither url nor spawn.command', base],
    ['both url and spawn.command', { ...base, url: 'http://127.0.0.1:1', spawn: { ...base.spawn, command: 'x' } }],
    ['a non-http url', { ...base, url: 'file:///tmp/bridge' }],
    ['a relative url', { ...base, url: '127.0.0.1:4279' }],
    ['an out-of-range port', { ...base, spawn: { ...base.spawn, command: 'x', port: 70000 } }],
    ['an empty spawn arg', { ...base, spawn: { ...base.spawn, command: 'x', args: [''] } }],
    ['a zero ready timeout', { ...base, spawn: { ...base.spawn, command: 'x', readyTimeoutMs: 0 } }],
    ['a zero request timeout', { ...base, url: 'http://127.0.0.1:1', requestTimeoutMs: 0 }],
  ])('fails loud on %s', (_label, config) => {
    expect(() => resolveConfig(config)).toThrow(TypeError)
  })
})

describe('OpennessSpecLoopAdapter', () => {
  it('forwards a passing validate', async () => {
    const { adapter } = await urlAdapter()
    await expect(adapter.validate({ coolingTimeMs: 12000 })).resolves.toEqual({ ok: true, reasons: [] })
  })

  it('forwards a bridge refusal verbatim', async () => {
    const bridge = await startFakeBridge({
      validate: () => ({ ok: false, reasons: ['unknown parameter "nope"'] }),
    })
    open.push(bridge)
    const ctx = new Context()
    contexts.push(ctx)
    const adapter = new OpennessSpecLoopAdapter(ctx, OpennessSpecLoopAdapter.Config(configOf({ url: bridge.baseUrl })))
    await expect(adapter.validate({ nope: 1 })).resolves.toEqual({ ok: false, reasons: ['unknown parameter "nope"'] })
  })

  it('throws on a validate transport failure so the engine classifies S3', async () => {
    const { adapter, bridge } = await urlAdapter()
    await bridge.close()
    await expect(adapter.validate({ coolingTimeMs: 12000 })).rejects.toThrow(/unreachable/)
  })

  it('throws on a malformed validate response', async () => {
    const bridge = await startFakeBridge({ validate: () => ({ ok: 'yes', reasons: [] }) })
    open.push(bridge)
    const ctx = new Context()
    contexts.push(ctx)
    const adapter = new OpennessSpecLoopAdapter(ctx, OpennessSpecLoopAdapter.Config(configOf({ url: bridge.baseUrl })))
    await expect(adapter.validate({})).rejects.toThrow(/malformed openness bridge \/validate response/)
  })

  it('passes a successful run through with the health environment merged in', async () => {
    const { adapter } = await urlAdapter()
    await expect(adapter.run({ params: { coolingTimeMs: 12000 } })).resolves.toMatchObject({
      status: 'success',
      result: { compileErrors: 0, compileWarnings: 0, compileMs: 100 },
      licenseMs: 100,
      environment: { softwareVersion: 'TIA Portal Openness 21.0.0.0 (fake)', osKernel: 'test-kernel' },
    })
  })

  it('keeps the run environment when the bridge reports one', async () => {
    const bridge = await startFakeBridge({
      run: () => ({
        runId: 'r',
        status: 'success',
        result: { compileErrors: 0 },
        environment: { softwareVersion: 'bridge-reported' },
      }),
    })
    open.push(bridge)
    const ctx = new Context()
    contexts.push(ctx)
    const adapter = new OpennessSpecLoopAdapter(ctx, OpennessSpecLoopAdapter.Config(configOf({ url: bridge.baseUrl })))
    await expect(adapter.run({ params: {} })).resolves.toMatchObject({
      environment: { softwareVersion: 'bridge-reported' },
    })
  })

  it('passes a diverged outcome through', async () => {
    const bridge = await startFakeBridge({
      run: () => ({ runId: 'r', status: 'diverged', error: 'compile faulted' }),
    })
    open.push(bridge)
    const ctx = new Context()
    contexts.push(ctx)
    const adapter = new OpennessSpecLoopAdapter(ctx, OpennessSpecLoopAdapter.Config(configOf({ url: bridge.baseUrl })))
    await expect(adapter.run({ params: {} })).resolves.toMatchObject({
      status: 'diverged',
      error: 'compile faulted',
    })
  })

  it('settles killed immediately when cancelled before submission', async () => {
    const { adapter, bridge } = await urlAdapter()
    const controller = new AbortController()
    controller.abort()
    await expect(adapter.run({ params: {}, signal: controller.signal }))
      .resolves.toEqual({ status: 'killed', error: 'cancelled before submission' })
    expect(bridge.requests.filter(request => request.path === '/run')).toHaveLength(0)
  })

  it('settles killed and fires /cancel when the signal aborts an in-flight run', async () => {
    const bridge = await startFakeBridge({ run: () => 'hang' })
    open.push(bridge)
    const ctx = new Context()
    contexts.push(ctx)
    const adapter = new OpennessSpecLoopAdapter(ctx, OpennessSpecLoopAdapter.Config(configOf({ url: bridge.baseUrl })))
    const controller = new AbortController()
    const pending = adapter.run({ params: { coolingTimeMs: 12000 }, signal: controller.signal })
    await new Promise<void>(resolve => setTimeout(resolve, 20))
    controller.abort()
    await expect(pending).resolves.toEqual({ status: 'killed', error: 'cancelled by the spec-loop signal' })
    await new Promise<void>(resolve => setTimeout(resolve, 20))
    const cancel = bridge.requests.find(request => request.path === '/cancel')
    expect(cancel).toBeDefined()
    expect(typeof (cancel?.body as { runId?: unknown } | undefined)?.runId).toBe('string')
  })

  it('reports a run timeout as infrastructure', async () => {
    const bridge = await startFakeBridge({ run: () => 'hang' })
    open.push(bridge)
    const ctx = new Context()
    contexts.push(ctx)
    const adapter = new OpennessSpecLoopAdapter(
      ctx,
      OpennessSpecLoopAdapter.Config(configOf({ url: bridge.baseUrl, requestTimeoutMs: 50 })),
    )
    const outcome = await adapter.run({ params: {} })
    expect(outcome.status).toBe('infrastructure')
    expect(outcome.error ?? '').toContain('timed out after 50ms')
  })

  it('reports a bridge outage as infrastructure', async () => {
    const { adapter, bridge } = await urlAdapter()
    await bridge.close()
    const outcome = await adapter.run({ params: {} })
    expect(outcome.status).toBe('infrastructure')
    expect(outcome.error ?? '').toContain('unreachable')
  })

  it('reports a malformed run response as infrastructure', async () => {
    const bridge = await startFakeBridge({ run: () => ({ runId: 'r', status: 'nope' }) })
    open.push(bridge)
    const ctx = new Context()
    contexts.push(ctx)
    const adapter = new OpennessSpecLoopAdapter(ctx, OpennessSpecLoopAdapter.Config(configOf({ url: bridge.baseUrl })))
    const outcome = await adapter.run({ params: {} })
    expect(outcome.status).toBe('infrastructure')
    expect(outcome.error ?? '').toContain('malformed openness bridge /run response')
  })

  it('spawn mode validates through the spawned URL and kills the child on dispose', async () => {
    const bridge = await startFakeBridge()
    open.push(bridge)
    const port = new URL(bridge.baseUrl).port
    const factory = fakeSpawnFactory([`{"event":"listening","url":"http://127.0.0.1:${port}"}`])
    const ctx = new Context()
    contexts.push(ctx)
    const adapter = new OpennessSpecLoopAdapter(ctx, OpennessSpecLoopAdapter.Config(configOf({
      spawn: { command: 'dotnet', args: ['OpennessBridge.dll'], cwd: 'C:\\b', port: 0, readyTimeoutMs: 5000 },
    })), { spawn: factory.spawn })
    await expect(adapter.validate({})).resolves.toEqual({ ok: true, reasons: [] })
    expect(factory.calls).toEqual([{ command: 'dotnet', args: ['OpennessBridge.dll'], cwd: 'C:\\b' }])
    expect(factory.child.killed).toBe(false)
    await ctx.fiber.dispose()
    expect(factory.child.killed).toBe(true)
  })

  it('spawn mode surfaces a start failure in validate', async () => {
    const factory = fakeSpawnFactory([])
    const ctx = new Context()
    contexts.push(ctx)
    const adapter = new OpennessSpecLoopAdapter(ctx, OpennessSpecLoopAdapter.Config(configOf({ spawn: { command: 'dotnet', args: [], cwd: '', port: 0, readyTimeoutMs: 50 } })), { spawn: factory.spawn })
    await expect(adapter.validate({})).rejects.toThrow(/openness bridge start failed: .*did not report its listening URL/)
  })

  it('spawn mode reports a start failure as an infrastructure run outcome', async () => {
    const factory = fakeSpawnFactory([])
    const ctx = new Context()
    contexts.push(ctx)
    const adapter = new OpennessSpecLoopAdapter(ctx, OpennessSpecLoopAdapter.Config(configOf({ spawn: { command: 'dotnet', args: [], cwd: '', port: 0, readyTimeoutMs: 50 } })), { spawn: factory.spawn })
    const outcome = await adapter.run({ params: {} })
    expect(outcome.status).toBe('infrastructure')
    expect(outcome.error ?? '').toContain('openness bridge start failed')
  })
})
