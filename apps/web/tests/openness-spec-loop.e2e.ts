// Keyless assembled-Web evidence for the Openness spec-loop overlay: boots the
// shipped Web composition patched with examples/openness-spec-loop/cordis.yml,
// points the adapter at an in-process fake bridge, and drives one spec_loop
// call whose initial candidate satisfies immediately — no model call in any
// mode, so the providers-only fixture mounts the catalog without a script.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { CallId } from '@deepseek-ai/dsh-llm'
// Declaration merge only: makes ctx.tools visible for tool execution.
import type {} from '@deepseek-ai/dsh-tools'
import { assertFixtureInventory, launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'

const OVERLAY = fileURLToPath(new URL('../../../examples/openness-spec-loop/cordis.yml', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/openness-spec-loop', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.jsonl')
const MODE = webSnapshotMode()

const SPEC = {
  id: 'compile-clean',
  objective: { path: 'compileErrors', direction: 'minimize' },
  assertions: [{ id: 'errors', path: 'compileErrors', predicate: 'lte', target: 0 }],
  budgets: { maxIterations: 8 },
  repair: { margin: 1, maxNoImprovement: 3 },
}

interface FakeBridge {
  baseUrl: string
  close(): Promise<void>
  requestCount(path: string): number
}

/** In-process fake bridge: the wire the adapter drives, without TIA. */
async function startFakeBridge(): Promise<FakeBridge> {
  const counts = new Map<string, number>()
  const record = (path: string): void => {
    counts.set(path, (counts.get(path) ?? 0) + 1)
  }
  const server: Server = createServer((req, res) => {
    const path = req.url ?? '/'
    record(path)
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    if (req.method === 'GET' && path === '/health') {
      res.end(JSON.stringify({ ok: true, environment: { softwareVersion: 'fake', osKernel: 'test' } }))
      return
    }
    if (req.method === 'POST' && path === '/validate') {
      res.end(JSON.stringify({ ok: true, reasons: [] }))
      return
    }
    if (req.method === 'POST' && path === '/run') {
      res.end(JSON.stringify({
        runId: 'run',
        status: 'success',
        result: { compileErrors: 0, compileWarnings: 0, compileMs: 100 },
        licenseMs: 100,
      }))
      return
    }
    if (req.method === 'POST' && path === '/cancel') {
      res.end('{"ok":true}')
      return
    }
    res.end('{"error":"unknown route"}')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    }),
    requestCount: path => counts.get(path) ?? 0,
  }
}

describe.skipIf(MODE === 'record')('web e2e: Openness spec-loop overlay', () => {
  let scaffold: WebScaffold
  let bridge: FakeBridge

  beforeAll(async () => {
    bridge = await startFakeBridge()
    vi.stubEnv('OPENNESS_BRIDGE_URL', bridge.baseUrl)
    // replayProvidersOnly mounts the provider catalog without any recorded
    // script to consume; the satisfying initial candidate needs no model call.
    scaffold = await launchWebScaffold({
      replayFixture: FIXTURE,
      replayProvidersOnly: true,
      extraOverlayPath: OVERLAY,
    })
  }, 120_000)

  afterAll(async () => {
    await scaffold?.close()
    vi.unstubAllEnvs()
    await bridge?.close()
  })

  it('mounts the adapter through the overlay and completes a satisfying spec_loop run', async () => {
    const adapter = scaffold.ctx.get('specLoopAdapter')
    expect(adapter).toBeDefined()
    await expect(adapter.validate({ coolingTimeMs: 12000 })).resolves.toEqual({ ok: true, reasons: [] })
    const result = await scaffold.ctx.tools.execute({
      signal: AbortSignal.timeout(30_000),
      callId: CallId('openness-spec-loop-web-e2e'),
      name: 'spec_loop',
      arguments: { spec: SPEC, initialParams: { coolingTimeMs: 12000 } },
    })
    if (result.isError) {
      throw new Error(`spec_loop failed: ${JSON.stringify(result.value)}`)
    }
    expect((result.value as { status: string }).status).toBe('satisfied')
    expect(bridge.requestCount('/validate')).toBe(2)
    expect(bridge.requestCount('/run')).toBe(1)
  }, 60_000)

  it('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.jsonl'])
  })
})
