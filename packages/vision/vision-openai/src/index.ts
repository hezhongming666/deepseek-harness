/**
 * `@deepseek-ai/dsh-vision-openai`: registers an OpenAI-compatible vision
 * `VisionProvider` with `ctx.vision`. A function/namespace plugin (NOT a
 * default-export service): it registers INTO the seam's provider registry.
 *
 * @module @deepseek-ai/dsh-vision-openai
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-vision'
import { OpenAIVisionProvider } from './provider.ts'
import type { OpenAIVisionLimits } from './provider.ts'

export {
  DEFAULT_VISION_PROMPT,
  OPENAI_VISION_PROVIDER_ID,
  OpenAIVisionProvider,
} from './provider.ts'
export type { OpenAIVisionLimits } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'vision-openai'

/** The vision seam this provider registers into. */
export const inject = ['vision']

/** Plugin config: the provider's endpoint, model, credential, and timeout (all defaulted). */
export interface Config {
  /** Bearer API key. Empty = provider unavailable; `$DSH_VISION_API_KEY` is a fallback. */
  apiKey?: string
  /** OpenAI-compatible base URL. */
  baseUrl?: string
  /** Vision model name. */
  model?: string
  /** Request timeout in milliseconds. */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  apiKey: z.string().default(''),
  baseUrl: z.string().default('https://api.openai.com/v1'),
  model: z.string().default('gpt-4o'),
  timeoutMs: z.number().default(60_000),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** A resource limit must be a positive finite number. */
function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`vision-openai: ${name} must be a positive finite number`)
  }
}

/** Register the OpenAI-compatible vision provider with `ctx.vision`. */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveFinite('timeoutMs', resolved.timeoutMs)
  const apiKey = resolved.apiKey || process.env.DSH_VISION_API_KEY || ''
  const limits: OpenAIVisionLimits = {
    apiKey,
    baseUrl: resolved.baseUrl,
    model: resolved.model,
    timeoutMs: resolved.timeoutMs,
  }
  ctx.vision.registerProvider(new OpenAIVisionProvider(limits))
}
