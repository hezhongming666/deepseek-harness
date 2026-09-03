# `@deepseek-ai/dsh-vision`

图片理解 capability seam（`ctx.vision`）：provider 注册表 + 与注册顺序无关的选择语义 + 请求/结果词汇表 + `VisionError` 错误分类。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `provider` | 自动选择 | 显式指定 provider id；`$DSH_VISION_PROVIDER` 等价覆盖 |

选择语义在执行时解析：配置 id 未注册 → `VISION_PROVIDER_CONFIGURED_MISSING`；注册但不可用 → `VISION_PROVIDER_CONFIGURED_UNAVAILABLE`；未配置且唯一可用 → 自动选；多个可用 → `VISION_PROVIDER_AMBIGUOUS`；无可用 → `VISION_PROVIDER_UNAVAILABLE`。

## Model Experience

该 seam 本身不面向模型；`@deepseek-ai/dsh-tool-vision` 把它包装成 `understand_image` 工具。每次调用消费一次视觉模型请求，结果经 `maxOutputChars` 在服务层裁剪。

## Known Limitations and Deferred Work

- 图片输入仅接受 `http(s)` URL 或 `data:` URI；本地文件路径由 Consumer 用 `ctx.fs` 解析（当前 `dsh-tool-vision` 未实现，属其已知限制）。
