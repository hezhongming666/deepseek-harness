// Shared in-process fake bridge for provider-openness tests: a real HTTP
// server on a loopback port speaking the Openness bridge protocol, with
// scriptable routes. Tests never spawn a child process.
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** One recorded bridge request. */
interface RecordedRequest {
  path: string
  method: string
  body: unknown
}

/** A scriptable route's reply: a JSON body, a raw status envelope, or a hang. */
interface RawStatus {
  __status: number
  body?: unknown
}

/** What one scripted route may return. */
type RouteReply = Record<string, unknown> | RawStatus | 'hang'

/** Scriptable route behavior. */
export interface FakeBridgeOptions {
  /** /validate handler. */
  validate?: (body: unknown) => RouteReply
  /** /run handler. */
  run?: (body: unknown) => RouteReply
  /** /health handler. */
  health?: (body: unknown) => RouteReply
}

/** The started fake bridge and its recorded traffic. */
export interface FakeBridge {
  baseUrl: string
  requests: RecordedRequest[]
  close(): Promise<void>
}

const DEFAULT_ENVIRONMENT = {
  softwareVersion: 'TIA Portal Openness 21.0.0.0 (fake)',
  osKernel: 'test-kernel',
}

const DEFAULT_RUN: Record<string, unknown> = {
  runId: 'unset',
  status: 'success',
  result: { compileErrors: 0, compileWarnings: 0, compileMs: 100 },
  licenseMs: 100,
}

function reply(res: ServerResponse, value: RouteReply | undefined): void {
  if (value === undefined || value === 'hang') return
  const isRaw = '__status' in value
  const status = isRaw ? (value as RawStatus).__status : 200
  const body = isRaw ? (value as RawStatus).body : value
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * Start a scriptable fake bridge on an ephemeral loopback port.
 * @param options - per-route handlers; defaults mirror the shipped fake host.
 * @returns the bridge handle with its base URL and request log.
 */
export async function startFakeBridge(options: FakeBridgeOptions = {}): Promise<FakeBridge> {
  const requests: RecordedRequest[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      let body: unknown
      try {
        body = text.length === 0 ? undefined : JSON.parse(text)
      } catch {
        body = text
      }
      requests.push({ path: req.url ?? '/', method: req.method ?? 'GET', body })
      const path = req.url ?? '/'
      if (req.method === 'GET' && path === '/health') {
        reply(res, options.health === undefined
          ? { ok: true, environment: DEFAULT_ENVIRONMENT }
          : options.health(body))
        return
      }
      if (req.method === 'POST' && path === '/validate') {
        reply(res, options.validate === undefined ? { ok: true, reasons: [] } : options.validate(body))
        return
      }
      if (req.method === 'POST' && path === '/run') {
        reply(res, options.run === undefined ? DEFAULT_RUN : options.run(body))
        return
      }
      if (req.method === 'POST' && path === '/cancel') {
        res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' })
        res.end('{"ok":true}')
        return
      }
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end('{"error":"unknown route"}')
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  let closed = false
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      if (closed) return
      closed = true
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve()
          else reject(error)
        })
      })
    },
  }
}
