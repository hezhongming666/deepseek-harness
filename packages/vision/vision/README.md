# `@deepseek-ai/dsh-vision`

English | [中文](README.zh.md)

Image-understanding capability seam (`ctx.vision`): the provider registry, order-independent selection semantics, the request/result vocabulary, and the `VisionError` failure taxonomy.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `provider` | auto-selected | Explicit provider id; `$DSH_VISION_PROVIDER` is an equivalent override |

Selection resolves at execution time: configured id not registered → `VISION_PROVIDER_CONFIGURED_MISSING`; registered but unavailable → `VISION_PROVIDER_CONFIGURED_UNAVAILABLE`; not configured and exactly one available → auto-selected; several available → `VISION_PROVIDER_AMBIGUOUS`; none available → `VISION_PROVIDER_UNAVAILABLE`.

## Model Experience

Indirectly, through `dsh-tool-vision`, which wraps this seam as the `understand_image` tool; each call consumes one vision model request, and the result is truncated at the service layer by `maxOutputChars`.

#### KV Cache effect

Independent — this package issues no model requests of its own; the provider's request goes out only when the tool executes.

## Known Limitations and Deferred Work

- Image inputs accept only `http(s)` URLs or `data:` URIs; local file paths are resolved by the Consumer through `ctx.fs` (not implemented in `dsh-tool-vision` today — its own known limitation).
