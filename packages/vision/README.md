# Vision packages

Image-understanding capability family: the abstract `ctx.vision` seam, an OpenAI-compatible provider, and the model-facing `understand_image` tool.

| Package | `ctx` key | Role |
|---|---|---|
| [`@deepseek-ai/dsh-vision`](vision/README.md) | `ctx.vision` | Service Definition: provider registry + order-independent selection + `maxOutputChars` enforcement |
| [`@deepseek-ai/dsh-vision-openai`](vision-openai/README.md) | — (registers into `ctx.vision`) | Provider: OpenAI-compatible multimodal `chat/completions`, redirects refused |
| [`@deepseek-ai/dsh-tool-vision`](tool-vision/README.md) | — (registers on `ctx.tools`) | Consumer: the `understand_image` tool |

## 启用（opt-in）

图片理解需要视觉 API 密钥，因此不作为 shipped 默认，而是在你的 profile `cordis.patch.yml` 里按需插入这三行：

```yaml
- id: vision
  name: '@deepseek-ai/dsh-vision'
  config:
    provider: openai
- id: vision-openai
  name: '@deepseek-ai/dsh-vision-openai'
  config:
    baseUrl: https://api.openai.com/v1   # 可换成任意 OpenAI 兼容端点
    model: gpt-4o                        # 可换成 qwen-vl-max 等
- id: tool-vision
  name: '@deepseek-ai/dsh-tool-vision'
```

密钥通过环境变量 `DSH_VISION_API_KEY` 提供（或在 `config.apiKey` 里内联，不推荐）。未提供密钥时 provider 处于不可用状态，`understand_image` 调用在运行时结构化报错，不影响其它能力。
