# `@deepseek-ai/dsh-tool-vision`

[English](README.md) | 中文

模型工具 `understand_image`，走 `ctx.vision`。本包只负责 schema、参数校验、输出上限与渲染，不负责提供方选择或网络访问。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否注册 `understand_image` |
| `timeoutMs` | `60000` | 协作式超时预算（挂在 `ToolDefinition.timeoutMs` 上） |
| `maxOutputChars` | `4000` | 返回文本上限（服务层裁剪） |

## Model Experience

### `understand_image` 工具 schema

#### 模型看到什么

生成的 [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-vision) 中的 `understand_image` schema 与描述。`image` 接受 `http(s)` URL、`data:` URI 或经 `ctx.fs` 解析为 data URI 的本地图片路径（上限 5 MB）；可选 `prompt` 提具体问题；结果是 `{ content }` 文本。

#### Token effect

有条件 — schema 文本是每次组合的固定成本；每次调用还额外支付经 `maxOutputChars` 截断的渲染结果。

#### KV Cache effect

仅追加 — schema 构成固定的稳定前缀；它不会使已可复用的提示词前缀失效。

## Known Limitations and Deferred Work

- 本地路径仅按扩展名推断 mime（PNG/JPEG/WebP/GIF）；未做 magic-byte 校验，远程引用的格式校验由提供方负责。
