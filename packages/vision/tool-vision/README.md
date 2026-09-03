# `@deepseek-ai/dsh-tool-vision`

English | [中文](README.zh.md)

Model-facing `understand_image` tool over `ctx.vision`. This package owns the schema, argument validation, the output bound, and rendering — never provider selection or network access.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Whether to register `understand_image` |
| `timeoutMs` | `60000` | Cooperative timeout budget (carried on `ToolDefinition.timeoutMs`) |
| `maxOutputChars` | `4000` | Returned-text cap (service-layer truncation) |

## Model Experience

### `understand_image` tool schema

#### What the model sees

The `understand_image` schema and description in the generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-vision). `image` accepts an `http(s)` URL, a `data:` URI, or a local image path resolved through `ctx.fs` into a data URI (capped at 5 MB); the optional `prompt` asks a specific question; the result is `{ content }` text.

#### Token effect

Conditional — the schema text is a fixed per-composition cost; each call additionally pays the rendered result truncated by `maxOutputChars`.

#### KV Cache effect

Append-only — the schema contributes a fixed stable prefix; it does not invalidate an already-reusable prompt prefix.

## Known Limitations and Deferred Work

- Local paths infer the mime type by extension only (PNG/JPEG/WebP/GIF); bytes are not magic-validated, and remote references leave format validation to the provider.
