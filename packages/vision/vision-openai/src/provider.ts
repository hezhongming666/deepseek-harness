/**
 * OpenAI-compatible vision provider for `ctx.vision`: posts a multimodal
 * chat-completions request and returns the model text. The credential-bearing
 * request refuses redirects (a 3xx response is an error, never followed), so the
 * configured endpoint cannot forward the API key to another origin.
 *
 * @module @deepseek-ai/dsh-vision-openai/provider
 */

import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { VisionError } from '@deepseek-ai/dsh-vision'
import type { VisionProvider, VisionUnderstandRequest, VisionUnderstandResult } from '@deepseek-ai/dsh-vision'

/** Stable id this provider registers under. */
export const OPENAI_VISION_PROVIDER_ID = 'openai'

/** Fallback instruction when a request omits its prompt. */
export const DEFAULT_VISION_PROMPT = '详细描述这张图片的内容'

/** Resolved provider limits (the plugin's schemastery Config supplies defaults). */
export interface OpenAIVisionLimits {
  /** Bearer credential sent as `Authorization`. */
  apiKey: string
  /** OpenAI-compatible base URL; `/chat/completions` is appended. */
  baseUrl: string
  /** Vision model name (e.g. `gpt-4o`, `qwen-vl-max`). */
  model: string
  /** Request timeout in milliseconds. */
  timeoutMs: number
}

/** The OpenAI-compatible vision provider. */
export class OpenAIVisionProvider implements VisionProvider {
  readonly id = OPENAI_VISION_PROVIDER_ID

  constructor(private readonly limits: OpenAIVisionLimits) {}

  /** Usable only with a credential; never performs network work. */
  available(): boolean {
    return this.limits.apiKey.length > 0
  }

  async understand(request: VisionUnderstandRequest, signal?: AbortSignal): Promise<VisionUnderstandResult> {
    if (signal?.aborted) throw new VisionError('vision understand aborted', 'VISION_ABORTED')

    using d = deadline(signal, this.limits.timeoutMs, 'VISION_TIMEOUT')
    const content = await this.call(request, d.signal)
    return { content, truncated: false }
  }

  /** Issue one multimodal request and extract the model text. */
  private async call(request: VisionUnderstandRequest, signal: AbortSignal): Promise<string> {
    const endpoint = `${this.limits.baseUrl.replace(/\/+$/, '')}/chat/completions`
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.limits.apiKey}`,
        },
        body: JSON.stringify({
          model: this.limits.model,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: request.prompt ?? DEFAULT_VISION_PROMPT },
              { type: 'image_url', image_url: { url: request.image } },
            ],
          }],
        }),
        signal,
      })
    } catch (error: unknown) {
      throw translateAbortOrNetwork(error, signal)
    }

    if (isRedirectStatus(response.status)) {
      await response.body?.cancel()
      throw new VisionError('vision request was redirected; the configured endpoint must not redirect credential-bearing requests', 'VISION_REDIRECT_BLOCKED')
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new VisionError(`vision API returned HTTP ${response.status}`, 'VISION_PROVIDER_ERROR')
    }

    let data: unknown
    try {
      data = await response.json()
    } catch (error: unknown) {
      throw new VisionError(`vision API returned invalid JSON: ${String(error)}`, 'VISION_PROVIDER_ERROR', { cause: error })
    }
    const content = extractContent(data)
    if (content === undefined) {
      throw new VisionError('vision API returned no message content', 'VISION_PROVIDER_ERROR')
    }
    return content
  }
}

/** HTTP redirect status codes that carry a `Location`. */
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/** Extract the first assistant message `content` from a chat-completions JSON body. */
function extractContent(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const choices = (data as Record<string, unknown>).choices
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const message = (choices[0] as Record<string, unknown>).message as Record<string, unknown> | undefined
  const content = message?.content
  return typeof content === 'string' ? content : undefined
}

/**
 * Translate a thrown fetch error into a `VisionError`, classified by the
 * deadline signal: our timeout fired → `VISION_TIMEOUT`; any other abort →
 * `VISION_ABORTED`; otherwise a transport/network failure →
 * `VISION_PROVIDER_ERROR`.
 */
function translateAbortOrNetwork(error: unknown, signal: AbortSignal): VisionError {
  const timeout = timeoutOf(signal, 'VISION_TIMEOUT')
  if (timeout !== undefined) return new VisionError('vision request timed out', 'VISION_TIMEOUT', { cause: timeout })
  if (signal.aborted) return new VisionError('vision request aborted', 'VISION_ABORTED', { cause: error })
  return new VisionError(`vision request failed: ${String(error)}`, 'VISION_PROVIDER_ERROR', { cause: error })
}
