# `@deepseek-ai/dsh-tool-vision`

模型工具 `understand_image`，走 `ctx.vision`。本包只负责 schema、参数校验、输出上限与渲染，不负责 provider 选择或网络访问。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否注册 `understand_image` |
| `timeoutMs` | `60000` | 协作式超时预算（挂在 `ToolDefinition.timeoutMs` 上） |
| `maxOutputChars` | `4000` | 返回文本上限（服务层裁剪） |

## Model Experience

`understand_image` 的 `image` 接受 `http(s)` URL、`data:` URI 或本地图片路径（经 `ctx.fs` 解析为 data URI，上限 5 MB），可选 `prompt` 提具体问题；返回 `{ content }` 文本。每次调用消费一次视觉模型请求。

## Known Limitations and Deferred Work

- 本地路径仅按扩展名推断 mime（PNG/JPEG/WebP/GIF）；未做 magic-byte 校验，远程引用的格式校验由 provider 负责。
