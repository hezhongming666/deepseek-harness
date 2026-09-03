import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAIVisionProvider } from '@deepseek-ai/dsh-vision-openai'

function makeProvider(overrides: Partial<ConstructorParameters<typeof OpenAIVisionProvider>[0]> = {}) {
  return new OpenAIVisionProvider({
    apiKey: 'sk-test',
    baseUrl: 'https://api.example.com/v1',
    model: 'gpt-4o',
    timeoutMs: 5_000,
    ...overrides,
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OpenAIVisionProvider', () => {
  it('is available only with a credential', () => {
    expect(makeProvider().available()).toBe(true)
    expect(makeProvider({ apiKey: '' }).available()).toBe(false)
  })

  it('posts a multimodal request and returns the model text', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'a cat' } }] }))
    vi.stubGlobal('fetch', fetchMock)

    const out = await makeProvider().understand({ image: 'data:image/png;base64,AA', prompt: 'what is this?' })

    expect(out).toEqual({ content: 'a cat', truncated: false })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }]
    expect(url).toBe('https://api.example.com/v1/chat/completions')
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('manual')
    expect(init.headers.authorization).toBe('Bearer sk-test')
  })

  it('rejects a redirect response and never follows it', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example.com' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(makeProvider().understand({ image: 'data:image/png;base64,AA' })).rejects.toThrow(
      expect.objectContaining({ code: 'VISION_REDIRECT_BLOCKED' }),
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws VISION_PROVIDER_ERROR on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'nope' }, 500)))
    await expect(makeProvider().understand({ image: 'data:image/png;base64,AA' })).rejects.toThrow(
      expect.objectContaining({ code: 'VISION_PROVIDER_ERROR' }),
    )
  })

  it('throws VISION_PROVIDER_ERROR on invalid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(makeProvider().understand({ image: 'data:image/png;base64,AA' })).rejects.toThrow(
      expect.objectContaining({ code: 'VISION_PROVIDER_ERROR' }),
    )
  })

  it('throws VISION_PROVIDER_ERROR when content is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ choices: [] })))
    await expect(makeProvider().understand({ image: 'data:image/png;base64,AA' })).rejects.toThrow(
      expect.objectContaining({ code: 'VISION_PROVIDER_ERROR' }),
    )
  })
})
