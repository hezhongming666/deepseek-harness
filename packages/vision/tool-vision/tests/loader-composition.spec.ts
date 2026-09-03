// REAL-composition tier (packages/AGENTS.md): the three vision plugins boot
// from a test-only cordis.yml through the real Loader + Include path, the
// external vision HTTP call is mocked, and `understand_image` answers a data-URI
// image through the assembled ctx.vision seam.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import VisionRuntime from '@deepseek-ai/dsh-vision'
import * as VisionOpenai from '@deepseek-ai/dsh-vision-openai'
import * as ToolVision from '@deepseek-ai/dsh-tool-vision'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  vi.unstubAllGlobals()
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** Boot the three vision plugins through the real Loader from a cordis.yml. */
async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-vision-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-vision'",
    '  config:',
    '    provider: openai',
    "- name: '@deepseek-ai/dsh-vision-openai'",
    '  config:',
    '    apiKey: test-key',
    '    baseUrl: https://api.example.com/v1',
    '    model: gpt-4o',
    "- name: '@deepseek-ai/dsh-tool-vision'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-vision', VisionRuntime],
    ['@deepseek-ai/dsh-vision-openai', VisionOpenai],
    ['@deepseek-ai/dsh-tool-vision', ToolVision],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

function mockVisionResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('vision real Loader composition through cordis.yml', () => {
  it('registers understand_image and answers a data-URI image through the provider', async () => {
    const ctx = await boot()
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('understand_image')

    vi.stubGlobal('fetch', vi.fn(async () => mockVisionResponse('a black dog')))

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('vision-call'),
      name: 'understand_image',
      arguments: { image: 'data:image/png;base64,AA', prompt: 'what is this?' },
    })

    expect(result.isError).toBe(false)
    expect(resultText(result)).toBe('a black dog')
  }, 30_000)

  it('refuses a local path when no filesystem is mounted', async () => {
    const ctx = await boot()

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('vision-local'),
      name: 'understand_image',
      arguments: { image: 'photo.png' },
    })

    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain('filesystem capability')
  }, 30_000)
})
