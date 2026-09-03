import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import VisionRuntime, {
  VisionError,
  type VisionProvider,
  type VisionUnderstandResult,
} from '@deepseek-ai/dsh-vision'

function makeProvider(
  id: string,
  available: boolean,
  understand: (request: { image: string }) => Promise<VisionUnderstandResult> = () => Promise.resolve({ content: 'ok', truncated: false }),
): VisionProvider {
  return { id, available: () => available, understand }
}

const usable = true
const unusable = false

function result(marker: string, overrides: Partial<VisionUnderstandResult> = {}): VisionUnderstandResult {
  return { content: marker, truncated: false, ...overrides }
}

async function mountVision(config: ConstructorParameters<typeof VisionRuntime>[1] = {}): Promise<{ ctx: Context; vision: VisionRuntime }> {
  const ctx = new Context()
  await ctx.plugin(VisionRuntime, config)
  return { ctx, vision: ctx.vision }
}

describe('VisionRuntime registration', () => {
  it('registers a provider and unregisters it via the returned disposer', async () => {
    const { vision } = await mountVision()
    const dispose = vision.registerProvider(makeProvider('openai', usable))
    await expect(vision.understand({ image: 'data:image/png;base64,AA' })).resolves.toMatchObject({ content: 'ok' })
    dispose()
    await expect(vision.understand({ image: 'data:image/png;base64,AA' })).rejects.toThrow(
      expect.objectContaining({ code: 'VISION_PROVIDER_UNAVAILABLE' }),
    )
  })

  it('throws VISION_DUPLICATE_PROVIDER on a duplicate id', async () => {
    const { vision } = await mountVision()
    vision.registerProvider(makeProvider('openai', usable))
    expect(() => vision.registerProvider(makeProvider('openai', usable))).toThrow(
      expect.objectContaining({ code: 'VISION_DUPLICATE_PROVIDER' }),
    )
  })

  it('disposes provider registrations when the contributing fiber is disposed (HMR safety)', async () => {
    const { ctx, vision } = await mountVision()
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.vision.registerProvider(makeProvider('openai', usable))
    }, { inject: ['vision'] }))
    await expect(vision.understand({ image: 'data:image/png;base64,AA' })).resolves.toMatchObject({ content: 'ok' })
    await fiber.dispose()
    await expect(vision.understand({ image: 'data:image/png;base64,AA' })).rejects.toThrow(
      expect.objectContaining({ code: 'VISION_PROVIDER_UNAVAILABLE' }),
    )
  })
})

describe('VisionRuntime execution resolution', () => {
  it('throws VISION_PROVIDER_UNAVAILABLE when nothing is registered', async () => {
    const { vision } = await mountVision()
    await expect(vision.understand({ image: 'data:image/png;base64,AA' })).rejects.toThrow(
      expect.objectContaining({ code: 'VISION_PROVIDER_UNAVAILABLE' }),
    )
  })

  it('throws VISION_PROVIDER_UNAVAILABLE when providers exist but none are usable', async () => {
    const { vision } = await mountVision()
    vision.registerProvider(makeProvider('openai', unusable))
    await expect(vision.understand({ image: 'data:image/png;base64,AA' })).rejects.toThrow(
      expect.objectContaining({ code: 'VISION_PROVIDER_UNAVAILABLE' }),
    )
  })

  it('throws VISION_PROVIDER_CONFIGURED_MISSING for an unregistered configured id', async () => {
    const { vision } = await mountVision({ provider: 'other' })
    vision.registerProvider(makeProvider('openai', usable))
    await expect(vision.understand({ image: 'data:image/png;base64,AA' })).rejects.toThrow(
      expect.objectContaining({ code: 'VISION_PROVIDER_CONFIGURED_MISSING' }),
    )
  })

  it('throws VISION_PROVIDER_CONFIGURED_UNAVAILABLE for an unusable configured id', async () => {
    const { vision } = await mountVision({ provider: 'openai' })
    vision.registerProvider(makeProvider('openai', unusable))
    await expect(vision.understand({ image: 'data:image/png;base64,AA' })).rejects.toThrow(
      expect.objectContaining({ code: 'VISION_PROVIDER_CONFIGURED_UNAVAILABLE' }),
    )
  })

  it('throws VISION_PROVIDER_AMBIGUOUS rather than picking by order', async () => {
    const { vision } = await mountVision()
    vision.registerProvider(makeProvider('a', usable))
    vision.registerProvider(makeProvider('b', usable))
    await expect(vision.understand({ image: 'data:image/png;base64,AA' })).rejects.toThrow(
      expect.objectContaining({ code: 'VISION_PROVIDER_AMBIGUOUS' }),
    )
  })

  it('runs the configured provider even when another usable provider is registered', async () => {
    const { vision } = await mountVision({ provider: 'b' })
    vision.registerProvider(makeProvider('a', usable, () => Promise.resolve(result('a'))))
    vision.registerProvider(makeProvider('b', usable, () => Promise.resolve(result('b'))))
    await expect(vision.understand({ image: 'data:image/png;base64,AA' })).resolves.toMatchObject({ content: 'b' })
  })

  it('propagates the abort signal to the provider', async () => {
    const { vision } = await mountVision()
    const seen: (AbortSignal | undefined)[] = []
    vision.registerProvider({
      id: 'openai',
      available: () => usable,
      understand: (_request, signal) => { seen.push(signal); return Promise.resolve(result('ok')) },
    })
    const controller = new AbortController()
    await vision.understand({ image: 'data:image/png;base64,AA' }, controller.signal)
    expect(seen[0]).toBe(controller.signal)
  })
})

describe('VisionRuntime maxOutputChars enforcement', () => {
  it('truncates content and sets truncated when a provider over-returns', async () => {
    const { vision } = await mountVision()
    vision.registerProvider(makeProvider('openai', usable, () => Promise.resolve(result('hello world'))))
    const out = await vision.understand({ image: 'data:image/png;base64,AA', maxOutputChars: 5 })
    expect(out.content).toBe('hello')
    expect(out.truncated).toBe(true)
  })

  it('leaves truncated false when within the bound', async () => {
    const { vision } = await mountVision()
    vision.registerProvider(makeProvider('openai', usable, () => Promise.resolve(result('hello'))))
    const out = await vision.understand({ image: 'data:image/png;base64,AA', maxOutputChars: 10 })
    expect(out.content).toBe('hello')
    expect(out.truncated).toBe(false)
  })
})

describe('VisionError', () => {
  it('is a HarnessError carrying its code', () => {
    const error = new VisionError('boom', 'VISION_PROVIDER_ERROR')
    expect(error.code).toBe('VISION_PROVIDER_ERROR')
    expect(error.name).toBe('VisionError')
  })
})
