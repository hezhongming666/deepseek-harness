# `@deepseek-ai/dsh-vision-openai`

OpenAI 兼容视觉 provider，注册进 `ctx.vision`。走多模态 `chat/completions`（`image_url` 内容块），面向 gpt-4o / qwen-vl 等兼容端点。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `apiKey` | `''` | Bearer 密钥；为空时 provider 不可用；`$DSH_VISION_API_KEY` 兜底 |
| `baseUrl` | `https://api.openai.com/v1` | OpenAI 兼容端点，自动追加 `/chat/completions` |
| `model` | `gpt-4o` | 视觉模型名 |
| `timeoutMs` | `60000` | 请求超时 |

## Model Experience

每次 `understand` 消费一次视觉模型请求；无本地 token/cache 效应。

## Known Limitations and Deferred Work

- 响应体整体读入内存后才解析，未做字节上限；超大响应可能占用超出预期的内存（服务层只裁剪最终文本）。
- 凭据请求拒绝一切重定向（`VISION_REDIRECT_BLOCKED`），与 web 组的安全策略一致。
