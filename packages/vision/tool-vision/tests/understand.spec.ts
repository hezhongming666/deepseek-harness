import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { applyUnderstandImageTool, mimeTypeForImagePath, resolveImageRef } from '@deepseek-ai/dsh-tool-vision'

function mountTool() {
  const registered: ToolDefinition[] = []
  const sections: string[] = []
  const understand = vi.fn(async () => ({ content: 'understood', truncated: false }))
  const ctx = new Context()
  ctx.provide('tools', { register: (def: ToolDefinition) => { registered.push(def); return () => {} } })
  ctx.provide('systemPrompt', { section: (s: { name: string }) => { sections.push(s.name) } })
  ctx.provide('vision', { understand })
  applyUnderstandImageTool(ctx, 60_000, 4_000)
  return { registered, sections, understand }
}

describe('understand_image tool', () => {
  it('registers the tool and its system-prompt guidance', () => {
    const { registered, sections } = mountTool()
    expect(registered).toHaveLength(1)
    expect(registered[0]?.name).toBe('understand_image')
    expect(sections).toContain('tool:understand_image')
  })

  it('executes through ctx.vision and returns the content', async () => {
    const { registered, understand } = mountTool()
    const tool = registered[0]
    if (!tool) throw new Error('tool not registered')
    const signal = new AbortController().signal
    const value = await tool.execute({ image: 'data:image/png;base64,AA', prompt: 'q' }, { signal } as never)
    expect(value).toEqual({ content: 'understood' })
    expect(understand).toHaveBeenCalledWith({ image: 'data:image/png;base64,AA', prompt: 'q', maxOutputChars: 4_000 }, signal)
  })
})

describe('mimeTypeForImagePath', () => {
  it('maps known extensions and rejects unknown', () => {
    expect(mimeTypeForImagePath('a.PNG')).toBe('image/png')
    expect(mimeTypeForImagePath('b.jpeg')).toBe('image/jpeg')
    expect(mimeTypeForImagePath('c.webp')).toBe('image/webp')
    expect(mimeTypeForImagePath('c.txt')).toBeUndefined()
  })
})

describe('resolveImageRef', () => {
  it('passes http(s) and data URIs through unchanged', async () => {
    const ctx = new Context()
    const signal = new AbortController().signal
    await expect(resolveImageRef(ctx, 'https://example.com/a.png', signal)).resolves.toBe('https://example.com/a.png')
    await expect(resolveImageRef(ctx, 'data:image/png;base64,AA', signal)).resolves.toBe('data:image/png;base64,AA')
  })

  it('throws when a local path has no filesystem service', async () => {
    const ctx = new Context()
    await expect(resolveImageRef(ctx, 'a.png', new AbortController().signal)).rejects.toThrow(/filesystem capability/)
  })

  it('resolves a local path into a base64 data URI', async () => {
    const ctx = new Context()
    ctx.provide('fs', {
      resolve: async () => ({ displayPath: '/x/a.png' }),
      readBytes: async () => new Uint8Array([1, 2, 3]),
    })
    const out = await resolveImageRef(ctx, '/x/a.png', new AbortController().signal)
    expect(out).toBe(`data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}`)
  })

  it('rejects a non-image extension', async () => {
    const ctx = new Context()
    ctx.provide('fs', { resolve: async () => ({}), readBytes: async () => new Uint8Array(0) })
    await expect(resolveImageRef(ctx, '/x/a.txt', new AbortController().signal)).rejects.toThrow(/supported image extension/)
  })
})
