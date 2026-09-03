/**
 * Vocabulary for the image-understanding capability seam (`ctx.vision`).
 * @module @deepseek-ai/dsh-vision/types
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/**
 * What one image-understanding backend is asked to understand. The request
 * carries the image as an `http(s)` URL or a `data:` URI; local-file resolution
 * belongs to the consumer, which has filesystem access. `maxOutputChars` is a
 * consumer-layer bound passed through unchanged and enforced on the way back by
 * the seam (see {@link VisionUnderstandResult}).
 */
export interface VisionUnderstandRequest {
  /** Image reference: an `http(s)` URL or a `data:` URI. */
  readonly image: string
  /** Optional question or instruction; a provider falls back to a description prompt. */
  readonly prompt?: string
  /** Upper bound on returned characters; the seam truncates to it. Omitted = no bound. */
  readonly maxOutputChars?: number
}

/**
 * Normalized image-understanding outcome. `truncated` is set by the seam when
 * it cut `content` down to `maxOutputChars`.
 */
export interface VisionUnderstandResult {
  /** Model-generated text about the image. */
  readonly content: string
  /** True when the seam truncated `content` to `maxOutputChars`. */
  readonly truncated: boolean
}

/**
 * An image-understanding backend. Registered with `ctx.vision.registerProvider`.
 * `id` is a stable string, unique within this seam.
 */
export interface VisionProvider {
  readonly id: string
  /** Cheap local usability check; must not make network calls. */
  available(): boolean
  /** Run one understanding request; honor `signal` for cancellation. */
  understand(request: VisionUnderstandRequest, signal?: AbortSignal): Promise<VisionUnderstandResult>
}

/**
 * Typed vision error with a machine-routable, open-string `code` and chained
 * `cause`. Shared codes cover unavailable, missing, unusable, ambiguous, or
 * duplicate providers, cancellation, timeout, provider failure, and the
 * credential-bearing redirect refusal enforced by the OpenAI provider.
 */
export class VisionError extends HarnessError {}
