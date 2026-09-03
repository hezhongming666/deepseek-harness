/**
 * Model-facing `understand_image` tool over `ctx.vision`. This package owns the
 * schema, validation, prompt guidance, the output bound, and rendering, never
 * concrete providers. Enablement controls tool registration; an enabled tool
 * remains visible when its provider is unavailable and fails with a structured
 * error at execution time.
 * @module @deepseek-ai/dsh-tool-vision
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-vision'
import { applyUnderstandImageTool, VISION_MAX_OUTPUT_CHARS } from './understand.ts'

export {
  VISION_MAX_IMAGE_BYTES,
  VISION_MAX_OUTPUT_CHARS,
  applyUnderstandImageTool,
  mimeTypeForImagePath,
  resolveImageRef,
} from './understand.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-vision'

/** Services required by the vision tool suite. */
export const inject = ['tools', 'vision', 'systemPrompt']

/** Default cooperative tool-call timeout budget (ms) for `understand_image`. */
export const DEFAULT_VISION_TOOL_TIMEOUT_MS = 60_000

/** Plugin config: whether to register the tool, plus its timeout and output caps. */
export interface Config {
  /** Register `understand_image`. Defaults to true. */
  enabled?: boolean
  /** Cooperative timeout budget (ms) for `understand_image`. Defaults to 60000. */
  timeoutMs?: number
  /** Upper bound on returned characters. Defaults to 4000. */
  maxOutputChars?: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  timeoutMs: z.number().default(DEFAULT_VISION_TOOL_TIMEOUT_MS),
  maxOutputChars: z.number().default(VISION_MAX_OUTPUT_CHARS),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** Configured counts and timeouts must be positive integers. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-vision: ${name} must be a positive integer`)
  }
}

/**
 * Register the vision tool when enabled. The tool's cooperative timeout budget
 * and output cap are resolved here; the tool's disposer is fiber-scoped (the
 * effect-based registries clean up on dispose), so no manual teardown is needed.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveInteger('timeoutMs', resolved.timeoutMs)
  assertPositiveInteger('maxOutputChars', resolved.maxOutputChars)
  if (resolved.enabled) {
    applyUnderstandImageTool(ctx, resolved.timeoutMs, resolved.maxOutputChars)
  }
}
