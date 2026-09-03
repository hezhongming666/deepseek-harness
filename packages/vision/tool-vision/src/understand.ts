/**
 * The model-facing `understand_image` tool: understand the content of an image.
 * Execution goes through `ctx.vision` — this module owns only the model-facing
 * schema, argument validation, local-file resolution, the output bound, and text
 * rendering, never provider selection or network access.
 */

import { Buffer } from 'node:buffer'
import { extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-vision'

/** Default upper bound on returned characters (the `maxOutputChars` config). */
export const VISION_MAX_OUTPUT_CHARS = 4000

/** Inclusive byte cap on a local image read before it becomes a data URI. */
export const VISION_MAX_IMAGE_BYTES = 5_000_000

/** Extensions `understand_image` accepts for local paths; the provider stays authoritative for remote references. */
const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/**
 * Map a path to its declared image media type by extension.
 * @param filePath - local path whose extension selects the media type.
 * @returns the media type for a supported extension, or `undefined` for unknown ones.
 */
export function mimeTypeForImagePath(filePath: string): string | undefined {
  return IMAGE_MIME_BY_EXT[extname(filePath).toLowerCase()]
}

/**
 * Normalize a model-supplied image reference to an `http(s)` URL or `data:` URI.
 * URL/data URI pass through; a local path is resolved through the optional
 * filesystem capability and base64-encoded into a data URI.
 * @param ctx - context whose optional `fs` service resolves and reads local files.
 * @param image - the raw image argument (URL, data URI, or local path).
 * @param signal - cancellation signal forwarded to filesystem I/O.
 * @returns a provider-ready image reference.
 */
export async function resolveImageRef(ctx: Context, image: string, signal: AbortSignal): Promise<string> {
  if (image.startsWith('http://') || image.startsWith('https://') || image.startsWith('data:')) {
    return image
  }
  const fs = ctx.get('fs')
  if (fs === undefined) {
    throw new Error(`cannot understand "${image}": local image paths require the filesystem capability; pass an http(s) URL or a data: URI instead`)
  }
  const mimeType = mimeTypeForImagePath(image)
  if (mimeType === undefined) {
    throw new Error(`cannot understand "${image}": the path does not claim a supported image extension (PNG/JPEG/WebP/GIF)`)
  }
  const target = await fs.resolve(image, { signal })
  const bytes = await fs.readBytes(target, signal, VISION_MAX_IMAGE_BYTES)
  return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`
}

/**
 * Register the `understand_image` tool and its system-prompt guidance.
 *
 * @param ctx - context whose `tools` and `systemPrompt` registries receive the
 *   registrations; both are effect-scoped and unregister on plugin dispose.
 * @param timeoutMs - the cooperative tool-call budget (ms) attached as the tool's
 *   `ToolDefinition.timeoutMs` for `@deepseek-ai/dsh-tool-call-timeout-policy` to enforce.
 * @param maxOutputChars - the deployment's output cap, sent as the seam request's
 *   `maxOutputChars`.
 */
export function applyUnderstandImageTool(
  ctx: Context,
  timeoutMs: number,
  maxOutputChars: number,
): void {
  ctx.systemPrompt.section({
    name: 'tool:understand_image',
    order: 111,
    text: 'Use the understand_image tool to understand the content of an image. The image argument accepts an http(s) URL, a data: URI, or a local image path (resolved via the filesystem capability). Optionally pass a prompt to ask a specific question about the image.',
  })

  ctx.tools.register(defineTool({
    name: 'understand_image',
    description: 'Understand the content of an image. The image argument accepts an http(s) URL, a data: URI, or a local image path (resolved via the filesystem capability); optionally pass a prompt to ask a specific question about the image.',
    parameters: {
      image: {
        type: 'string',
        required: true,
        description: 'Image reference: an http(s) URL, a data: URI, or a local image path.',
      },
      prompt: {
        type: 'string',
        description: 'Optional question or instruction about the image.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.content }],
    },
    timeoutMs,
    // Provider reads do not mutate parent-agent state.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const image = await resolveImageRef(ctx, args.image, exec.signal)
      const result = await ctx.vision.understand({
        image,
        ...args.prompt !== undefined ? { prompt: args.prompt } : {},
        maxOutputChars,
      }, exec.signal)
      return { content: result.content }
    },
  }))
}
