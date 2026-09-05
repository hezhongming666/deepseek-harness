/**
 * Behavior of the `tia-compile` verifier against a local fake Openness
 * bridge: local empty-input guard, pass/fail verdicts with per-message
 * severity, fail-closed unavailable/import-failed paths, config validation,
 * and effect-scoped registration disposal.
 */

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import IaVerifiers from '@deepseek-ai/dsh-ia-verifier'
import * as IaVerifierOpenness from '@deepseek-ai/dsh-ia-verifier-openness'
import { resolveConfig, TIA_COMPILE_KIND } from '@deepseek-ai/dsh-ia-verifier-openness'

/** One canned `/run` verify response the fake bridge answers next. */
type CannedResponse = { status: number; body: unknown }

interface FakeBridge {
  url: string
  requests: Array<{ path: string; body: unknown }>
  answer(response: CannedResponse): void
  close(): Promise<void>
}

/** Start a local HTTP server replaying canned bridge responses. */
async function startFakeBridge(): Promise<FakeBridge> {
  let next: CannedResponse = { status: 200, body: { runId: 'unset', status: 'success' } }
  const requests: FakeBridge['requests'] = []
  const server = createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: Buffer | string) => { raw += typeof chunk === 'string' ? chunk : chunk.toString() })
    request.on('end', () => {
      let body: unknown = raw
      try {
        body = raw.length > 0 ? JSON.parse(raw) : undefined
      } catch {
        body = raw
      }
      requests.push({ path: request.url ?? '', body })
      response.writeHead(next.status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(next.body))
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    answer(value) { next = value },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve()
          else reject(error)
        })
      })
    },
  }
}

/** The compile `result` object a fake bridge reports. */
function result(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    compileErrors: 0,
    compileWarnings: 0,
    compileMs: 100,
    compileMessages: [],
    ...overrides,
  }
}

const GOOD_SCL = 'FUNCTION "IACheck" : Void\nBEGIN\nEND_FUNCTION'

let context: Context | undefined
let bridge: FakeBridge | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await bridge?.close()
  bridge = undefined
})

async function makeRegistry(config: { url?: string; blockName?: string } = {}): Promise<IaVerifiers> {
  context = new Context()
  await context.plugin(IaVerifiers, { builtins: [] })
  await context.plugin(IaVerifierOpenness, {
    url: config.url ?? bridge!.url,
    ...(config.blockName === undefined ? {} : { blockName: config.blockName }),
  })
  return context.iaVerifiers
}

describe('ia-verifier-openness', () => {
  it('fails at load without a bridge url', async () => {
    context = new Context()
    await context.plugin(IaVerifiers, { builtins: [] })
    await expect(context.plugin(IaVerifierOpenness, { url: '' }))
      .rejects.toThrow(/requires the url/)
  })

  it('rejects non-HTTP and invalid urls at config resolution', () => {
    expect(() => resolveConfig({ url: 'ftp://bridge:4281' })).toThrow(/absolute http/)
    expect(() => resolveConfig({ url: 'not a url' })).toThrow(/absolute http/)
  })

  it('rejects block names that are not TIA identifiers', () => {
    expect(() => resolveConfig({ url: 'http://127.0.0.1:1', blockName: 'Bad Name!' })).toThrow(/TIA identifier/)
  })

  it('registers the tia-compile kind and disposes it with the plugin fiber', async () => {
    bridge = await startFakeBridge()
    const registry = await makeRegistry()
    expect(registry.kinds()).toContain(TIA_COMPILE_KIND)
    await context!.fiber.dispose()
    expect(registry.kinds()).not.toContain(TIA_COMPILE_KIND)
    context = undefined
  })

  it('short-circuits empty submissions locally without a bridge round-trip', async () => {
    bridge = await startFakeBridge()
    const registry = await makeRegistry()
    const report = await registry.verify(TIA_COMPILE_KIND, { text: '   \n' })
    expect(report.pass).toBe(false)
    expect(report.diagnostics.map(diagnostic => diagnostic.code)).toEqual(['tia-compile-empty-input'])
    expect(report.diagnostics[0]?.severity).toBe('error')
    expect(report.evidence).toHaveLength(1)
    expect(bridge.requests).toHaveLength(0)
  })

  it('passes a clean compile and keeps warnings advisory', async () => {
    bridge = await startFakeBridge()
    bridge.answer({
      status: 200,
      body: {
        runId: 'run-clean',
        status: 'success',
        result: result({
          compileWarnings: 1,
          compileMessages: ['warning: unused variable'],
          compileMessageStates: ['warning'],
          blockName: 'IACheck',
        }),
      },
    })
    const registry = await makeRegistry()
    const report = await registry.verify(TIA_COMPILE_KIND, { text: GOOD_SCL })
    expect(report.kind).toBe(TIA_COMPILE_KIND)
    expect(report.pass).toBe(true)
    expect(report.diagnostics).toEqual([{
      code: 'tia-compile-warning',
      severity: 'warning',
      message: 'warning: unused variable',
    }])
    expect(report.evidence[0]?.kind).toBe('tia-compile')
    expect(report.evidence[0]?.summary).toContain('0 error(s)')
    expect(report.evidence[0]?.summary).toContain('1 warning(s)')
    expect(bridge.requests).toHaveLength(1)
    const request = bridge.requests[0]!
    expect(request.path).toBe('/run')
    const body = request.body as { action?: string; blockName?: string; source?: string }
    expect(body.action).toBe('verify')
    expect(body.blockName).toBe('IACheck')
    expect(body.source).toBe(GOOD_SCL)
  })

  it('prefers vendorSource over text for the bridge round-trip', async () => {
    bridge = await startFakeBridge()
    bridge.answer({
      status: 200,
      body: {
        runId: 'run-vendor',
        status: 'success',
        result: result({ blockName: 'IACheck' }),
      },
    })
    const registry = await makeRegistry()
    const vendor = 'FUNCTION_BLOCK "Motor"\nBEGIN\nEND_FUNCTION_BLOCK'
    const report = await registry.verify(TIA_COMPILE_KIND, { text: 'PROGRAM Local\nEND_PROGRAM', vendorSource: vendor })
    expect(report.pass).toBe(true)
    const body = bridge.requests[0]!.body as { source?: string }
    expect(body.source).toBe(vendor)
  })

  it('treats an empty vendorSource as an empty submission locally', async () => {
    bridge = await startFakeBridge()
    const registry = await makeRegistry()
    const report = await registry.verify(TIA_COMPILE_KIND, { text: GOOD_SCL, vendorSource: '  ' })
    expect(report.pass).toBe(false)
    expect(report.diagnostics[0]?.code).toBe('tia-compile-empty-input')
    expect(bridge.requests).toHaveLength(0)
  })

  it('fails a compile with errors, attributing severity from the bridge states', async () => {
    bridge = await startFakeBridge()
    bridge.answer({
      status: 200,
      body: {
        runId: 'run-errors',
        status: 'success',
        result: result({
          compileErrors: 2,
          compileWarnings: 1,
          compileMessages: ['error one', 'error two', 'warning one'],
          compileMessageStates: ['error', 'error', 'warning'],
          blockName: 'IACheck',
        }),
      },
    })
    const registry = await makeRegistry()
    const report = await registry.verify(TIA_COMPILE_KIND, { text: GOOD_SCL })
    expect(report.pass).toBe(false)
    expect(report.diagnostics.map(diagnostic => diagnostic.severity)).toEqual(['error', 'error', 'warning'])
    expect(report.diagnostics.map(diagnostic => diagnostic.code))
      .toEqual(['tia-compile-error', 'tia-compile-error', 'tia-compile-warning'])
  })

  it('falls back to count-prefix attribution when the bridge omits states', async () => {
    bridge = await startFakeBridge()
    bridge.answer({
      status: 200,
      body: {
        runId: 'run-old-bridge',
        status: 'success',
        result: result({
          compileErrors: 1,
          compileWarnings: 1,
          compileMessages: ['the error', 'the warning'],
        }),
      },
    })
    const registry = await makeRegistry()
    const report = await registry.verify(TIA_COMPILE_KIND, { text: GOOD_SCL })
    expect(report.pass).toBe(false)
    expect(report.diagnostics.map(diagnostic => diagnostic.severity)).toEqual(['error', 'warning'])
  })

  it('fails closed with a synthetic error when counts and messages disagree', async () => {
    bridge = await startFakeBridge()
    bridge.answer({
      status: 200,
      body: {
        runId: 'run-inconsistent',
        status: 'success',
        result: result({ compileErrors: 3, compileMessages: ['just one message'], compileMessageStates: ['warning'] }),
      },
    })
    const registry = await makeRegistry()
    const report = await registry.verify(TIA_COMPILE_KIND, { text: GOOD_SCL })
    expect(report.pass).toBe(false)
    expect(report.diagnostics.some(diagnostic => diagnostic.severity === 'error')).toBe(true)
  })

  it('fails closed on a diverged import with the bridge error', async () => {
    bridge = await startFakeBridge()
    bridge.answer({
      status: 200,
      body: { runId: 'run-diverged', status: 'diverged', error: 'verify import of block "IACheck" failed' },
    })
    const registry = await makeRegistry()
    const report = await registry.verify(TIA_COMPILE_KIND, { text: GOOD_SCL })
    expect(report.pass).toBe(false)
    expect(report.diagnostics[0]?.code).toBe('tia-compile-import-failed')
    expect(report.diagnostics[0]?.message).toContain('verify import of block')
  })

  it('fails closed on infrastructure and killed statuses', async () => {
    bridge = await startFakeBridge()
    bridge.answer({ status: 200, body: { runId: 'run-infra', status: 'infrastructure', error: 'host gone' } })
    const registry = await makeRegistry()
    const infra = await registry.verify(TIA_COMPILE_KIND, { text: GOOD_SCL })
    expect(infra.pass).toBe(false)
    expect(infra.diagnostics[0]?.code).toBe('tia-compile-unavailable')
    bridge.answer({ status: 200, body: { runId: 'run-killed', status: 'killed', error: 'cancelled' } })
    const killed = await registry.verify(TIA_COMPILE_KIND, { text: GOOD_SCL })
    expect(killed.pass).toBe(false)
    expect(killed.diagnostics[0]?.code).toBe('tia-compile-unavailable')
  })

  it('fails closed when the bridge is unreachable', async () => {
    bridge = await startFakeBridge()
    const registry = await makeRegistry()
    await bridge.close()
    bridge = undefined
    const report = await registry.verify(TIA_COMPILE_KIND, { text: GOOD_SCL })
    expect(report.pass).toBe(false)
    expect(report.diagnostics[0]?.code).toBe('tia-compile-unavailable')
    expect(report.diagnostics[0]?.message).toContain('unreachable')
    expect(report.evidence[0]?.kind).toBe('tia-compile-unavailable')
  })

  it('fails closed on HTTP errors and malformed wire bodies', async () => {
    bridge = await startFakeBridge()
    bridge.answer({ status: 500, body: { error: 'project locked' } })
    const registry = await makeRegistry()
    const httpError = await registry.verify(TIA_COMPILE_KIND, { text: GOOD_SCL })
    expect(httpError.pass).toBe(false)
    expect(httpError.diagnostics[0]?.code).toBe('tia-compile-unavailable')
    expect(httpError.diagnostics[0]?.message).toContain('project locked')

    bridge.answer({ status: 200, body: 'not json' })
    const malformed = await registry.verify(TIA_COMPILE_KIND, { text: GOOD_SCL })
    expect(malformed.pass).toBe(false)
    expect(malformed.diagnostics[0]?.code).toBe('tia-compile-unavailable')

    bridge.answer({ status: 200, body: { runId: 'run-bad', status: 'success' } })
    const missingResult = await registry.verify(TIA_COMPILE_KIND, { text: GOOD_SCL })
    expect(missingResult.pass).toBe(false)
    expect(missingResult.diagnostics[0]?.code).toBe('tia-compile-unavailable')
  })

  it('rejects a duplicate tia-compile registration', async () => {
    bridge = await startFakeBridge()
    await makeRegistry()
    await expect(context!.plugin(IaVerifierOpenness, { url: bridge.url }))
      .rejects.toThrow(/already registered/)
  })
})
