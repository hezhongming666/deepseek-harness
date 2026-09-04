import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { BridgeHttpClient, BridgeHttpError } from '../src/http.ts'
import { startFakeBridge } from './fake-bridge.ts'
import type { FakeBridge } from './fake-bridge.ts'

const open: FakeBridge[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map(bridge => bridge.close()))
})

describe('BridgeHttpClient', () => {
  it('posts JSON and parses a 2xx response', async () => {
    const bridge = await startFakeBridge()
    open.push(bridge)
    const client = new BridgeHttpClient(bridge.baseUrl, { requestTimeoutMs: 5000 })
    await expect(client.post('/validate', { params: { thickness: 6 } })).resolves.toEqual({ ok: true, reasons: [] })
    expect(bridge.requests).toEqual([
      { path: '/validate', method: 'POST', body: { params: { thickness: 6 } } },
    ])
  })

  it('reports a non-2xx response with the bridge error text', async () => {
    const bridge = await startFakeBridge({
      run: () => ({ __status: 503, body: { error: 'TIA Portal not reachable' } }),
    })
    open.push(bridge)
    const client = new BridgeHttpClient(bridge.baseUrl, { requestTimeoutMs: 5000 })
    const error = await client.post('/run', { runId: 'r', params: {} }).then(
      () => undefined,
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(BridgeHttpError)
    expect((error as BridgeHttpError).status).toBe(503)
    expect((error as BridgeHttpError).message).toContain('TIA Portal not reachable')
    expect((error as BridgeHttpError).aborted).toBe(false)
  })

  it('reports malformed JSON on a 2xx response', async () => {
    const bridge = await startFakeBridge({ run: () => ({ __status: 200 }) })
    open.push(bridge)
    const client = new BridgeHttpClient(bridge.baseUrl, { requestTimeoutMs: 5000 })
    await expect(client.post('/run', { runId: 'r', params: {} })).rejects.toThrow(/malformed JSON/)
  })

  it('reports an unreachable bridge', async () => {
    const probe = createServer()
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(0, '127.0.0.1', resolve)
    })
    const port = (probe.address() as AddressInfo).port
    await new Promise<void>(resolve => probe.close(() => { resolve() }))
    const client = new BridgeHttpClient(`http://127.0.0.1:${port}`, { requestTimeoutMs: 5000 })
    const error = await client.get('/health').then(
      () => undefined,
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(BridgeHttpError)
    expect((error as BridgeHttpError).status).toBeUndefined()
    expect((error as BridgeHttpError).message).toContain('unreachable')
  })

  it('reports a timed-out request distinctly from a caller abort', async () => {
    const bridge = await startFakeBridge({ run: () => 'hang' })
    open.push(bridge)
    const client = new BridgeHttpClient(bridge.baseUrl, { requestTimeoutMs: 50 })
    const timeout = await client.post('/run', { runId: 'r', params: {} }).then(
      () => undefined,
      (caught: unknown) => caught,
    )
    expect(timeout).toBeInstanceOf(BridgeHttpError)
    expect((timeout as BridgeHttpError).timedOut).toBe(true)
    expect((timeout as BridgeHttpError).aborted).toBe(false)
    expect((timeout as BridgeHttpError).message).toContain('timed out')

    const controller = new AbortController()
    const request = client.post('/run', { runId: 'r2', params: {} }, controller.signal)
    controller.abort()
    const aborted = await request.then(
      () => undefined,
      (caught: unknown) => caught,
    )
    expect(aborted).toBeInstanceOf(BridgeHttpError)
    expect((aborted as BridgeHttpError).aborted).toBe(true)
    expect((aborted as BridgeHttpError).timedOut).toBe(false)
  })
})
