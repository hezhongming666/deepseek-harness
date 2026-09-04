/**
 * The TIA Portal Openness spec-loop adapter provider: registers one
 * `OpennessSpecLoopAdapter` as `ctx.specLoopAdapter`, talking to an Openness
 * bridge over the HTTP JSON protocol (see the package README for the wire
 * contract, deployment modes, and the bundled C# bridge). URL mode targets a
 * deployment-owned bridge; spawn mode starts and owns a local bridge process.
 * Misconfiguration fails at load; bridge outages, timeouts, and malformed
 * wire responses surface as `infrastructure` outcomes, and a cancelled run
 * settles `killed` immediately.
 * @module @deepseek-ai/dsh-provider-openness
 */

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SpecLoopAdapterService } from '@deepseek-ai/dsh-spec-loop'
import type {
  AdapterEnvironment,
  AdapterRunOutcome,
  AdapterRunRequest,
  SpecLoopParams,
  ValidationOutcome,
} from '@deepseek-ai/dsh-spec-loop'
import { BridgeHttpClient, BridgeHttpError } from './http.ts'
import { BridgeProcess } from './spawn.ts'
import type { SpawnLike } from './spawn.ts'
import type { Config, ResolvedConfig, SpawnConfig } from './types.ts'
import { parseHealthResponse, parseRunResponse, parseValidateResponse } from './wire.ts'

export { BridgeHttpClient, BridgeHttpError } from './http.ts'
export { BridgeProcess, buildSpawnArgs, parseListeningLine } from './spawn.ts'
export { parseHealthResponse, parseRunResponse, parseValidateResponse } from './wire.ts'
export type { FetchLike } from './http.ts'
export type { SpawnedChild, SpawnLike } from './spawn.ts'
export type { Config, ResolvedConfig, SpawnConfig } from './types.ts'
export type {
  BridgeHealthResponse,
  BridgeRunResponse,
  BridgeRunStatus,
  BridgeValidateResponse,
} from './types.ts'

const DEFAULT_REQUEST_TIMEOUT_MS = 300_000
const DEFAULT_READY_TIMEOUT_MS = 30_000

const DEFAULT_SPAWN: SpawnConfig = {
  command: '',
  args: [],
  cwd: '',
  port: 0,
  readyTimeoutMs: DEFAULT_READY_TIMEOUT_MS,
}

/** Render any thrown value without letting the render itself throw. */
function renderError(error: unknown): string {
  try {
    return String(error instanceof Error ? error.message : error)
  } catch {
    return '[unrenderable thrown value]'
  }
}

/**
 * Apply the semantic constraints the config schema cannot express: exactly
 * one of `url` and `spawn.command` must be configured, and every numeric cap
 * must be a positive safe integer.
 * @param config - the schema-validated config.
 * @returns the resolved per-mode config.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const hasUrl = config.url.trim().length > 0
  const hasSpawn = config.spawn.command.trim().length > 0
  if (hasUrl === hasSpawn) {
    throw new TypeError(
      'provider-openness requires exactly one of url (a running bridge) or spawn.command (a local bridge to own)',
    )
  }
  if (!Number.isSafeInteger(config.requestTimeoutMs) || config.requestTimeoutMs < 1) {
    throw new TypeError('provider-openness requestTimeoutMs must be a positive safe integer')
  }
  if (hasUrl) {
    let url: URL
    try {
      url = new URL(config.url)
    } catch {
      throw new TypeError(`provider-openness url must be an absolute http(s) URL, got ${JSON.stringify(config.url)}`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new TypeError(`provider-openness url must be an absolute http(s) URL, got ${JSON.stringify(config.url)}`)
    }
    return { kind: 'url', baseUrl: url.href.replace(/\/$/, ''), requestTimeoutMs: config.requestTimeoutMs }
  }
  const spawn = config.spawn
  if (spawn.port !== 0 && (!Number.isSafeInteger(spawn.port) || spawn.port < 1 || spawn.port > 65535)) {
    throw new TypeError('provider-openness spawn.port must be 0 or an integer between 1 and 65535')
  }
  if (!Number.isSafeInteger(spawn.readyTimeoutMs) || spawn.readyTimeoutMs < 1) {
    throw new TypeError('provider-openness spawn.readyTimeoutMs must be a positive safe integer')
  }
  if (spawn.args.some(arg => arg.length === 0)) {
    throw new TypeError('provider-openness spawn.args entries must be non-empty strings')
  }
  return { kind: 'spawn', spawn, requestTimeoutMs: config.requestTimeoutMs }
}

/** Optional construction seams; tests inject fakes, deployments use defaults. */
export interface AdapterOptions {
  /** Child-process spawner for spawn mode; defaults to `node:child_process`. */
  spawn?: SpawnLike
}

/**
 * The Openness spec-loop adapter provider. One instance per context provides
 * `ctx.specLoopAdapter`; the `spec_loop` tool resolves it through the service
 * store and drives every candidate through `validate` and `run`.
 */
export default class OpennessSpecLoopAdapter extends SpecLoopAdapterService {
  static Config: z<Config> = z.object({
    url: z.string().default(''),
    spawn: z.object({
      command: z.string().default(''),
      args: z.array(z.string()).default([]),
      cwd: z.string().default(''),
      port: z.number().step(1).min(0).max(65535).default(0),
      readyTimeoutMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_READY_TIMEOUT_MS),
    }).default(DEFAULT_SPAWN),
    requestTimeoutMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_REQUEST_TIMEOUT_MS),
  })

  private readonly resolved: ResolvedConfig
  private readonly options: AdapterOptions
  private client: BridgeHttpClient | undefined
  private bridgePromise: Promise<void> | undefined
  private healthPromise: Promise<AdapterEnvironment | undefined> | undefined
  private readyBridge: BridgeProcess | undefined

  constructor(ctx: Context, config: Config, options: AdapterOptions = {}) {
    super(ctx)
    this.resolved = resolveConfig(config)
    this.options = options
    if (this.resolved.kind === 'url') {
      this.client = new BridgeHttpClient(this.resolved.baseUrl, {
        requestTimeoutMs: this.resolved.requestTimeoutMs,
      })
    } else {
      // Effect-scoped cleanup: the spawned child dies with the owning fiber.
      ctx.effect(() => () => { this.killBridge() })
    }
  }

  private killBridge(): void {
    if (this.readyBridge !== undefined) this.readyBridge.kill()
    this.readyBridge = undefined
    this.client = undefined
    this.bridgePromise = undefined
  }

  /** Resolve the client, spawning the bridge first in spawn mode. */
  private ensureBridge(): Promise<void> {
    if (this.client !== undefined) return Promise.resolve()
    if (this.resolved.kind !== 'spawn') {
      return Promise.reject(new Error('provider-openness: url-mode bridge was not initialized'))
    }
    this.bridgePromise ??= BridgeProcess.start(
      this.resolved.spawn,
      this.options.spawn === undefined ? {} : { spawn: this.options.spawn },
    )
      .then((bridge) => {
        this.readyBridge = bridge
        this.client = new BridgeHttpClient(bridge.url, {
          requestTimeoutMs: this.resolved.requestTimeoutMs,
        })
      }, (error: unknown) => {
        this.bridgePromise = undefined
        throw new Error(`openness bridge start failed: ${renderError(error)}`)
      })
    return this.bridgePromise
  }

  /**
   * The cheap S1 gate: forward the candidate to the bridge's `/validate`.
   * Transport and wire failures throw so the engine classifies them as S3;
   * bridge refusals return the reasons verbatim.
   * @param params - the candidate parameter set.
   * @returns the S1-gate outcome.
   */
  async validate(params: SpecLoopParams): Promise<ValidationOutcome> {
    await this.ensureBridge()
    const client = this.client
    if (client === undefined) throw new Error('openness bridge is not ready')
    let value: unknown
    try {
      value = await client.post('/validate', { params })
    } catch (error) {
      throw new Error(`openness bridge validation failed: ${renderError(error)}`)
    }
    try {
      return parseValidateResponse(value)
    } catch (error) {
      throw new Error(`malformed openness bridge /validate response: ${renderError(error)}`)
    }
  }

  /**
   * Execute one candidate through the bridge. A caller abort settles
   * `killed` immediately (with a best-effort `/cancel`); timeouts, outages,
   * and malformed responses settle `infrastructure` with a diagnosis.
   * @param request - the candidate plus the cancellation signal.
   * @returns the run outcome.
   */
  async run(request: AdapterRunRequest): Promise<AdapterRunOutcome> {
    // Read through a function so TS cannot narrow the optional-chain result:
    // the signal aborts asynchronously between these checks.
    const aborted = (): boolean => request.signal?.aborted === true
    try {
      await this.ensureBridge()
    } catch (error) {
      return { status: 'infrastructure', error: renderError(error) }
    }
    const client = this.client
    if (client === undefined) return { status: 'infrastructure', error: 'openness bridge is not ready' }
    if (aborted()) {
      return { status: 'killed', error: 'cancelled before submission' }
    }
    const runId = randomUUID()
    const timeout = AbortSignal.timeout(this.resolved.requestTimeoutMs)
    const combined = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout])
    const onAbort = (): void => {
      if (aborted()) {
        // Best effort: the bridge's in-flight Openness call cannot be
        // preempted, so the cancel only tells it to drop the result.
        void client.post('/cancel', { runId }, AbortSignal.timeout(5_000)).catch(() => {})
      }
    }
    combined.addEventListener('abort', onAbort, { once: true })
    let value: unknown
    try {
      value = await client.post('/run', { runId, params: request.params }, combined)
    } catch (error) {
      if (aborted()) {
        return { status: 'killed', error: 'cancelled by the spec-loop signal' }
      }
      if (error instanceof BridgeHttpError && error.aborted) {
        return { status: 'killed', error: 'cancelled by the spec-loop signal' }
      }
      if (error instanceof BridgeHttpError) {
        return { status: 'infrastructure', error: error.message }
      }
      return { status: 'infrastructure', error: `openness bridge run failed: ${renderError(error)}` }
    } finally {
      combined.removeEventListener('abort', onAbort)
    }
    if (aborted()) {
      return { status: 'killed', error: 'cancelled by the spec-loop signal' }
    }
    let outcome: ReturnType<typeof parseRunResponse>
    try {
      outcome = parseRunResponse(value)
    } catch (error) {
      return { status: 'infrastructure', error: `malformed openness bridge /run response: ${renderError(error)}` }
    }
    const environment = outcome.environment ?? await this.environment()
    return {
      status: outcome.status,
      // The body arrived via JSON.parse, so every value is lossless JSON by
      // construction; the wire validator only checks the record shape.
      ...outcome.result === undefined ? {} : { result: outcome.result as unknown as SpecLoopParams },
      ...outcome.licenseMs === undefined ? {} : { licenseMs: outcome.licenseMs },
      ...outcome.error === undefined ? {} : { error: outcome.error },
      ...environment === undefined ? {} : { environment },
    }
  }

  /** The cached `/health` environment; undefined when the bridge never reports one. */
  private environment(): Promise<AdapterEnvironment | undefined> {
    this.healthPromise ??= this.fetchEnvironment().catch(() => undefined)
    return this.healthPromise
  }

  private async fetchEnvironment(): Promise<AdapterEnvironment | undefined> {
    const client = this.client
    if (client === undefined) return undefined
    let value: unknown
    try {
      value = await client.get('/health')
    } catch {
      return undefined
    }
    try {
      return parseHealthResponse(value).environment
    } catch {
      return undefined
    }
  }
}
