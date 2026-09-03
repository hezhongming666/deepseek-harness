# vision/ — 图片理解能力族

[English](README.md) | 中文

图片理解能力族：抽象的 `ctx.vision` seam、一个 OpenAI 兼容提供方，以及面向模型的 `understand_image` 工具。

| 包 | `ctx` 键 | 角色 |
|---|---|---|
| [`@deepseek-ai/dsh-vision`](vision/README.md) | `ctx.vision` | Service Definition：提供方注册表 + 与注册顺序无关的选择 + `maxOutputChars` 强制 |
| [`@deepseek-ai/dsh-vision-openai`](vision-openai/README.md) | —（注册进 `ctx.vision`） | Provider：OpenAI 兼容多模态 `chat/completions`，拒绝重定向 |
| [`@deepseek-ai/dsh-tool-vision`](tool-vision/README.md) | —（注册在 `ctx.tools` 上） | Consumer：`understand_image` 工具 |

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
    baseUrl: https://api.openai.com/v1   # swap for any OpenAI-compatible endpoint
    model: gpt-4o                        # swap for qwen-vl-max etc.
- id: tool-vision
  name: '@deepseek-ai/dsh-tool-vision'
```

密钥通过环境变量 `DSH_VISION_API_KEY` 提供（或在 `config.apiKey` 里内联，不推荐）。未提供密钥时提供方处于不可用状态，`understand_image` 调用在运行时结构化报错，不影响其它能力。
