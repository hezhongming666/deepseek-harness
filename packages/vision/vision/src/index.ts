/**
 * Service Definition for the image-understanding capability seam (`ctx.vision`):
 * a provider registry and provider-selecting execution for image understanding.
 * Duplicate ids are rejected. At execution time, a configured provider must
 * exist and be usable; without one, exactly one usable provider is required, so
 * selection never depends on registration order.
 * @module @deepseek-ai/dsh-vision
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  VisionProvider,
  VisionUnderstandRequest,
  VisionUnderstandResult,
} from './types.ts'
import { VisionError } from './types.ts'

export {
  VisionError,
} from './types.ts'
export type {
  VisionProvider,
  VisionUnderstandRequest,
  VisionUnderstandResult,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    vision: VisionRuntime
  }
}

/** Selection inputs for execution-time provider resolution. */
interface Selection {
  /** The configured provider id, if any. */
  readonly configuredId?: string
  /** Providers registered for this capability. */
  readonly providers: ReadonlyMap<string, VisionProvider>
}

/**
 * Config for the vision seam. `provider` pins which provider wins; it is
 * optional (a single registered usable provider auto-selects). Operational
 * overrides feed the same field rather than introduce a hidden priority chain.
 */
export interface VisionRuntimeConfig {
  /** Explicit provider id. Omitted = auto-select when exactly one usable. */
  readonly provider?: string
}

/**
 * The image-understanding service. Registered as `ctx.vision` (one instance per
 * context).
 *
 * Selection semantics (resolved at execution time, never order-dependent):
 * - A configured id that is registered and `available()` → that provider.
 * - A configured id not registered → `VISION_PROVIDER_CONFIGURED_MISSING`.
 * - A configured id registered but unavailable →
 *   `VISION_PROVIDER_CONFIGURED_UNAVAILABLE`.
 * - No id configured, exactly one registered usable provider → that provider.
 * - No id configured, multiple usable providers → `VISION_PROVIDER_AMBIGUOUS`.
 * - No id configured, no usable provider → `VISION_PROVIDER_UNAVAILABLE`.
 */
export class VisionRuntime extends Service {
  /**
   * Provider selection config. `$DSH_VISION_PROVIDER` is equivalent to
   * `provider` and is NOT a hidden priority chain.
   */
  static Config: z<VisionRuntimeConfig> = z.object({
    provider: z.string(),
  })

  private providers = new Map<string, VisionProvider>()
  private readonly providerId: string | undefined

  constructor(ctx: Context, config: VisionRuntimeConfig = {}) {
    super(ctx, 'vision')
    this.providerId = config.provider ?? process.env.DSH_VISION_PROVIDER
  }

  /**
   * Register a vision provider. Throws {@link VisionError}
   * `VISION_DUPLICATE_PROVIDER` if its id is already registered. Returns a
   * disposer; disposed with the calling fiber.
   * @param provider - the provider; its `id` is the registry key.
   * @returns the disposer that unregisters the provider.
   */
  registerProvider(provider: VisionProvider): () => void {
    if (this.providers.has(provider.id)) {
      throw new VisionError(`a vision provider with id "${provider.id}" is already registered`, 'VISION_DUPLICATE_PROVIDER')
    }
    const store = this.providers
    const dispose = this.ctx.effect(function* () {
      store.set(provider.id, provider)
      yield () => store.delete(provider.id)
    }, 'vision.registerProvider()')
    return () => void dispose()
  }

  /**
   * Run one image-understanding request through the selected provider. Resolves
   * the provider at call time with the selection rules above; throws
   * {@link VisionError} when the capability cannot run. The seam enforces
   * `request.maxOutputChars` on the result: if the provider over-returns,
   * `content` is truncated and `truncated` set.
   * @param request - the image reference plus optional prompt and output bound.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the provider's result, capped to `request.maxOutputChars`.
   */
  async understand(request: VisionUnderstandRequest, signal?: AbortSignal): Promise<VisionUnderstandResult> {
    const provider = resolveProvider({
      providers: this.providers,
      ...this.providerId !== undefined ? { configuredId: this.providerId } : {},
    })
    const result = await provider.understand(request, signal)
    return capOutput(result, request.maxOutputChars)
  }
}

/** Resolve the selected provider or throw the matching {@link VisionError}. */
function resolveProvider(selection: Selection): VisionProvider {
  const { configuredId, providers } = selection
  if (configuredId !== undefined) {
    const provider = providers.get(configuredId)
    if (!provider) {
      throw new VisionError(`configured vision provider "${configuredId}" is not registered`, 'VISION_PROVIDER_CONFIGURED_MISSING')
    }
    if (!provider.available()) {
      throw new VisionError(`configured vision provider "${configuredId}" is registered but unavailable`, 'VISION_PROVIDER_CONFIGURED_UNAVAILABLE')
    }
    return provider
  }
  const usable = [...providers.values()].filter(provider => provider.available())
  const [single] = usable
  if (single === undefined) {
    throw new VisionError('no usable vision provider is registered', 'VISION_PROVIDER_UNAVAILABLE')
  }
  if (usable.length > 1) {
    const ids = usable.map(provider => provider.id).join(', ')
    throw new VisionError(`multiple usable vision providers are registered (${ids}); configure one explicitly`, 'VISION_PROVIDER_AMBIGUOUS')
  }
  return single
}

/** Enforce `maxOutputChars` on a result: truncate `content` and flag it. */
function capOutput(result: VisionUnderstandResult, maxOutputChars: number | undefined): VisionUnderstandResult {
  if (maxOutputChars === undefined || result.content.length <= maxOutputChars) return result
  return { ...result, content: result.content.slice(0, maxOutputChars), truncated: true }
}

export default VisionRuntime
