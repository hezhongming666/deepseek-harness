/**
 * Spawn-mode bridge lifecycle: build the process arguments, wait for the
 * bridge's ready line, and kill the owned process on dispose. The spawn call
 * is injectable so tests never launch a child process; real deployments use
 * `node:child_process`.
 * @module @deepseek-ai/dsh-provider-openness/spawn
 */

import { spawn as nodeSpawn } from 'node:child_process'
import type { SpawnConfig } from './types.ts'

/** The minimal child-process surface `BridgeProcess` drives; injectable for tests. */
export interface SpawnedChild {
  /** Emits `data` (Buffer) on stdout, `close`, and `error`. */
  stdout: import('node:events').EventEmitter & { on(event: 'data', listener: (chunk: Buffer) => void): unknown }
  /** Buffered tail kept for spawn-failure diagnosis. */
  stderr: import('node:events').EventEmitter & { on(event: 'data', listener: (chunk: Buffer) => void): unknown }
  /** Terminate the child; the platform's default signal applies. */
  kill(): void
}

/** Injectable spawn signature matching `child_process.spawn`'s use here. */
export type SpawnLike = (command: string, args: string[], options: { cwd?: string }) => SpawnedChild

/**
 * Build the bridge argv for one spawn-mode config: the user's args followed
 * by the port flag when a fixed port is configured.
 * @param config - the validated spawn config.
 * @returns the full argument vector.
 */
export function buildSpawnArgs(config: SpawnConfig): string[] {
  return config.port > 0 ? [...config.args, '--port', String(config.port)] : [...config.args]
}

/**
 * Extract the bridge URL from one ready line. The bridge prints exactly one
 * line of the form `{"event":"listening","url":"http://127.0.0.1:<port>"}`.
 * @param chunk - stdout text; may contain partial lines (callers buffer).
 * @returns the listening URL when the chunk completes the ready line.
 */
export function parseListeningLine(chunk: string): string | undefined {
  for (const line of chunk.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let value: unknown
    try {
      value = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (typeof value !== 'object' || value === null) continue
    const record = value as { event?: unknown; url?: unknown }
    if (record['event'] === 'listening' && typeof record['url'] === 'string' && record['url'].length > 0) {
      return record['url']
    }
  }
  return undefined
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
 * One bridge process owned by the adapter: it resolves with the listening URL
 * or rejects with a ready-timeout diagnosis carrying the stderr tail.
 */
export class BridgeProcess {
  private readonly child: SpawnedChild

  private constructor(
    readonly url: string,
    child: SpawnedChild,
  ) {
    this.child = child
  }

  /**
   * Spawn the bridge and resolve once its ready line arrives.
   * @param config - the validated spawn config.
   * @param options - spawn implementation override (tests inject a fake).
   * @returns the ready bridge with its reported URL.
   */
  static async start(config: SpawnConfig, options: { spawn?: SpawnLike } = {}): Promise<BridgeProcess> {
    const spawn = options.spawn ?? ((command, args, opts): SpawnedChild =>
      nodeSpawn(command, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] }))
    const child = spawn(config.command, buildSpawnArgs(config), { cwd: config.cwd })
    let stderrTail = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-2048)
    })
    const ready = new Promise<BridgeProcess>((resolve, reject) => {
      let stdoutBuffer = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        const tail = stderrTail.trim()
        reject(new Error(
          `openness bridge did not report its listening URL within ${config.readyTimeoutMs}ms`
          + (tail.length === 0 ? '' : `; stderr: ${tail}`),
        ))
      }, config.readyTimeoutMs)
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBuffer += chunk.toString('utf8')
        const url = parseListeningLine(stdoutBuffer)
        if (url !== undefined && !settled) {
          settled = true
          clearTimeout(timer)
          resolve(new BridgeProcess(url, child))
        }
      })
      child.stdout.on('error', (error: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error(`openness bridge stdout failed: ${renderError(error)}`))
      })
    })
    return ready
  }

  /** Terminate the owned bridge process. */
  kill(): void {
    this.child.kill()
  }
}
