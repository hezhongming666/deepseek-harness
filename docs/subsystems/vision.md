# Vision

English | [中文](vision.zh.md)

The vision capability understands images through a provider-selected seam: `ctx.vision` keeps a provider registry whose selection resolves at execution time and never depends on registration order, the OpenAI-compatible provider implements multimodal `chat/completions`, and the model-facing Consumer exposes the `understand_image` tool. Like [web](web.md) it is **one optional capability**, not part of the agent loop, so its types and operations live here rather than in [core.md](core.md).

Service Definition: [dsh-vision](../../packages/vision/vision) (`ctx.vision`, the provider registry, execution-time selection, and the vocabulary below). The model-facing Consumer is [dsh-tool-vision](../../packages/vision/tool-vision), which registers the `understand_image` tool and resolves local image paths into data URIs through the optional filesystem. The shipped Provider is [dsh-vision-openai](../../packages/vision/vision-openai).

Sources: the seam vocabulary in [`packages/vision/vision/src/types.ts`](../../packages/vision/vision/src/types.ts).

## The seam vocabulary

The complete vocabulary a provider implementation works with. The request carries the image as an `http(s)` URL or a `data:` URI; local-file resolution belongs to the Consumer, which has filesystem access. The seam enforces `maxOutputChars` on the way back.

```ts type-equiv
/**
 * What one image-understanding backend is asked to understand. The request
 * carries the image as an `http(s)` URL or a `data:` URI; local-file resolution
 * belongs to the consumer, which has filesystem access. `maxOutputChars` is a
 * consumer-layer bound passed through unchanged and enforced on the way back by
 * the seam (see {@link VisionUnderstandResult}).
 */
interface VisionUnderstandRequest {
  /** Image reference: an `http(s)` URL or a `data:` URI. */
  readonly image: string
  /** Optional question or instruction; a provider falls back to a description prompt. */
  readonly prompt?: string
  /** Upper bound on returned characters; the seam truncates to it. Omitted = no bound. */
  readonly maxOutputChars?: number
}
```

```ts type-equiv
/**
 * Normalized image-understanding outcome. `truncated` is set by the seam when
 * it cut `content` down to `maxOutputChars`.
 */
interface VisionUnderstandResult {
  /** Model-generated text about the image. */
  readonly content: string
  /** True when the seam truncated `content` to `maxOutputChars`. */
  readonly truncated: boolean
}
```

```ts type-equiv
/**
 * An image-understanding backend. Registered with `ctx.vision.registerProvider`.
 * `id` is a stable string, unique within this seam.
 */
interface VisionProvider {
  readonly id: string
  /** Cheap local usability check; must not make network calls. */
  available(): boolean
  /** Run one understanding request; honor `signal` for cancellation. */
  understand(request: VisionUnderstandRequest, signal?: AbortSignal): Promise<VisionUnderstandResult>
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxvision--visionruntime"></a>

### `ctx.vision` — `VisionRuntime`

The image-understanding service. Registered as `ctx.vision` (one instance per context).

Selection semantics (resolved at execution time, never order-dependent):

- A configured id that is registered and `available()` → that provider.
- A configured id not registered → `VISION_PROVIDER_CONFIGURED_MISSING`.
- A configured id registered but unavailable → `VISION_PROVIDER_CONFIGURED_UNAVAILABLE`.
- No id configured, exactly one registered usable provider → that provider.
- No id configured, multiple usable providers → `VISION_PROVIDER_AMBIGUOUS`.
- No id configured, no usable provider → `VISION_PROVIDER_UNAVAILABLE`.

```ts cordis-catalog
/**
 * Register a vision provider. Throws {@link VisionError}
 * `VISION_DUPLICATE_PROVIDER` if its id is already registered. Returns a
 * disposer; disposed with the calling fiber.
 * @param provider - the provider; its `id` is the registry key.
 * @returns the disposer that unregisters the provider.
 */
registerProvider(provider: VisionProvider): () => void

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
async understand(request: VisionUnderstandRequest, signal?: AbortSignal): Promise<VisionUnderstandResult>
```

Source: [`packages/vision/vision/src/index.ts:65`](../../packages/vision/vision/src/index.ts)
<!-- END GENERATED cordis-surface -->
