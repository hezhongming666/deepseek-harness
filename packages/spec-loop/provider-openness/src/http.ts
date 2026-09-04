/**
 * Minimal HTTP client for the Openness bridge protocol. One instance per
 * adapter; `post`/`get` parse the JSON body and fold transport, timeout, and
 * status failures into {@link BridgeHttpError} with an `aborted` flag so the
 * adapter can distinguish caller cancellation from timeouts and outages.
 * @module @deepseek-ai/dsh-provider-openness/http
 */

/** The fetch subset the client drives; injectable for tests. */
export interface FetchLike {
  (input: string | URL, init?: RequestInit): Promise<Response>
}

/** Transport, timeout, or status failure while talking to the bridge. */
export class BridgeHttpError extends Error {
  /** HTTP status for a non-2xx response; undefined for transport/timeout failures. */
  readonly status: number | undefined
  /** True when the caller's signal (never the internal timeout) aborted the request. */
  readonly aborted: boolean
  /** True when the request exceeded the configured cap. */
  readonly timedOut: boolean

  constructor(message: string, options: { status?: number; aborted?: boolean; timedOut?: boolean } = {}) {
    super(message)
    this.name = 'BridgeHttpError'
    this.status = options.status
    this.aborted = options.aborted === true
    this.timedOut = options.timedOut === true
  }
}

/** Name of the abort reason `AbortSignal.timeout` installs. */
function abortedReason(signal: AbortSignal): unknown {
  return 'reason' in signal ? (signal as AbortSignal & { reason?: unknown }).reason : undefined
}

/** True when the abort came from `AbortSignal.timeout`, not the caller. */
function isTimeoutAbort(signal: AbortSignal): boolean {
  const reason = abortedReason(signal)
  return reason instanceof Error && reason.name === 'TimeoutError'
}

/**
 * Render a fetch-level throw without letting the render itself throw.
 * @param error - the thrown value.
 * @returns the message text.
 */
function renderError(error: unknown): string {
  try {
    return String(error instanceof Error ? error.message : error)
  } catch {
    return '[unrenderable thrown value]'
  }
}

/** Extract the bridge's `error` text from a non-2xx body, best effort. */
function bodyError(text: string): string | undefined {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value === 'object' && value !== null
      && typeof (value as { error?: unknown })['error'] === 'string') {
      return (value as { error: string })['error']
    }
  } catch {
    // The status code still names the failure.
  }
  return undefined
}

/**
 * One adapter's client for a single bridge base URL.
 * @param baseUrl - bridge origin, e.g. `http://127.0.0.1:4279`.
 * @param options - fetch implementation override and per-request timeout.
 */
export class BridgeHttpClient {
  private readonly fetchImpl: FetchLike

  constructor(
    readonly baseUrl: string,
    private readonly options: { fetch?: FetchLike; requestTimeoutMs: number },
  ) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
  }

  /**
   * `POST` one JSON body to a bridge path.
   * @param path - protocol route, e.g. `/validate`.
   * @param body - the request payload; serialized as JSON.
   * @param signal - optional caller abort; composed with the internal timeout.
   * @returns the parsed JSON response value.
   */
  async post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.request(path, { method: 'POST', body: JSON.stringify(body) }, signal)
  }

  /**
   * `GET` one bridge path.
   * @param path - protocol route, e.g. `/health`.
   * @param signal - optional caller abort; composed with the internal timeout.
   * @returns the parsed JSON response value.
   */
  async get(path: string, signal?: AbortSignal): Promise<unknown> {
    return this.request(path, { method: 'GET' }, signal)
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: { accept: 'application/json', ...init.body === undefined ? {} : { 'content-type': 'application/json' } },
        signal: combined,
      })
    } catch (error) {
      if (combined.aborted) {
        throw new BridgeHttpError(
          isTimeoutAbort(combined)
            ? `openness bridge request timed out after ${this.options.requestTimeoutMs}ms (${this.baseUrl}${path})`
            : `openness bridge request aborted (${this.baseUrl}${path})`,
          { aborted: !isTimeoutAbort(combined), timedOut: isTimeoutAbort(combined) },
        )
      }
      throw new BridgeHttpError(`openness bridge unreachable at ${this.baseUrl}${path}: ${renderError(error)}`)
    }
    const text = await response.text()
    if (response.status < 200 || response.status >= 300) {
      const detail = bodyError(text)
      throw new BridgeHttpError(
        `openness bridge ${path} returned HTTP ${response.status}${detail === undefined ? '' : `: ${detail}`}`,
        { status: response.status },
      )
    }
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new BridgeHttpError(`openness bridge ${path} returned malformed JSON: ${renderError(error)}`)
    }
  }
}
