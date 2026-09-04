/**
 * Wire and deployment types for the TIA Portal Openness spec-loop adapter:
 * the deployment config, the bridge's JSON protocol records, and the resolved
 * runtime config. Types only — no runtime code.
 * @module @deepseek-ai/dsh-provider-openness/types
 */

import type { AdapterEnvironment } from '@deepseek-ai/dsh-spec-loop'

/**
 * Deployment configuration for the Openness bridge adapter. All fields carry
 * schema defaults; semantic constraints (exactly one of `url` and
 * `spawn.command`) are enforced by `resolveConfig` at load.
 */
export interface Config {
  /** Base URL of an already-running bridge, e.g. `http://127.0.0.1:4279`. */
  url: string
  /** Spawn-mode entry: the adapter owns a local bridge process. */
  spawn: SpawnConfig
  /**
   * Cap for one HTTP request to the bridge, in milliseconds. Covers validate,
   * run, health, and cancel calls; a run over budget reports `infrastructure`.
   */
  requestTimeoutMs: number
}

/** Spawn-mode configuration: the adapter owns one local bridge process. */
export interface SpawnConfig {
  /** Bridge executable, e.g. `dotnet` or an absolute `OpennessBridge.exe` path. */
  command: string
  /** Arguments passed before the port flag, e.g. `['OpennessBridge.dll']`. */
  args: string[]
  /** Working directory for the spawned process. */
  cwd: string
  /** Fixed listening port; `0` lets the bridge pick one and report it. */
  port: number
  /** Cap for waiting on the bridge's ready line, in milliseconds. */
  readyTimeoutMs: number
}

/** Config after semantic validation; one field per deployment mode. */
export type ResolvedConfig =
  | { readonly kind: 'url'; readonly baseUrl: string; readonly requestTimeoutMs: number }
  | { readonly kind: 'spawn'; readonly spawn: SpawnConfig; readonly requestTimeoutMs: number }

/** Bridge-reported run status; mirrors the adapter seam's `AdapterRunStatus`. */
export type BridgeRunStatus = 'success' | 'diverged' | 'infrastructure' | 'killed'

/** `POST /run` response body, as received from the bridge. */
export interface BridgeRunResponse {
  /** Echo of the submitted run id. */
  runId: string
  status: BridgeRunStatus
  /** Structured numeric metrics; present exactly for `success`. */
  result?: { [key: string]: unknown }
  /** License time consumed by this run, in milliseconds. */
  licenseMs?: number
  /** Non-empty diagnosis for `diverged`/`infrastructure`/`killed`. */
  error?: string
  /** Version tuple recorded into the audit trail. */
  environment?: AdapterEnvironment
}

/** `POST /validate` response body, as received from the bridge. */
export interface BridgeValidateResponse {
  ok: boolean
  /** Non-empty when `ok` is false. */
  reasons: string[]
}

/** `GET /health` response body, as received from the bridge. */
export interface BridgeHealthResponse {
  ok: boolean
  /** Present when the bridge reports its deployment environment. */
  environment?: AdapterEnvironment
  /** Non-empty diagnosis when the bridge is not ready. */
  error?: string
}
