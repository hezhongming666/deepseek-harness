# `@deepseek-ai/dsh-vision-openai`

English | [中文](README.zh.md)

OpenAI-compatible vision provider registered into `ctx.vision`. It sends multimodal `chat/completions` requests (`image_url` content blocks) to gpt-4o / qwen-vl and compatible endpoints.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `apiKey` | `''` | Bearer credential; an empty value leaves the provider unavailable; `$DSH_VISION_API_KEY` is the fallback |
| `baseUrl` | `https://api.openai.com/v1` | OpenAI-compatible endpoint; `/chat/completions` is appended |
| `model` | `gpt-4o` | Vision model name |
| `timeoutMs` | `60000` | Request timeout |

## Model Experience

Indirectly, through `dsh-tool-vision`, which issues the model-visible `understand_image` calls; each `understand` consumes one vision model request with no local token or cache effects.

#### KV Cache effect

Independent — this package issues no model requests of its own; the request goes out only when the tool executes.

## Known Limitations and Deferred Work

- Response bodies are read into memory whole before parsing, with no byte cap; oversized responses may use more memory than expected (the service layer truncates only the final text).
- Credential-bearing requests refuse every redirect (`VISION_REDIRECT_BLOCKED`), matching the web group's security policy.
