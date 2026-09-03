# vision/ — image-understanding capability family

English | [中文](README.zh.md)

Image-understanding capability family: the abstract `ctx.vision` seam, an OpenAI-compatible provider, and the model-facing `understand_image` tool.

| Package | `ctx` key | Role |
|---|---|---|
| [`@deepseek-ai/dsh-vision`](vision/README.md) | `ctx.vision` | Service Definition: provider registry + order-independent selection + `maxOutputChars` enforcement |
| [`@deepseek-ai/dsh-vision-openai`](vision-openai/README.md) | — (registers into `ctx.vision`) | Provider: OpenAI-compatible multimodal `chat/completions`, redirects refused |
| [`@deepseek-ai/dsh-tool-vision`](tool-vision/README.md) | — (registers on `ctx.tools`) | Consumer: the `understand_image` tool |

## Opt-in enablement

Image understanding needs a vision API key, so it is not a shipped default; insert these three entries into your profile `cordis.patch.yml` instead:

```yaml
- id: vision
  name: '@deepseek-ai/dsh-vision'
  config:
    provider: openai
- id: vision-openai
  name: '@deepseek-ai/dsh-vision-openai'
  config:
    baseUrl: https://api.openai.com/v1   # swap for any OpenAI-compatible endpoint
    model: gpt-4o                        # swap for qwen-vl-max etc.
- id: tool-vision
  name: '@deepseek-ai/dsh-tool-vision'
```

Provide the key through the `DSH_VISION_API_KEY` environment variable (or inline in `config.apiKey`, not recommended). Without a key the provider stays unavailable, and `understand_image` calls fail with a structured error at runtime without affecting other capabilities.
