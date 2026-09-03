# Agent Note: 图片理解 capability seam（`ctx.vision`）

Status: implemented

[English](2026-08-23-vision-capability-seam.md) | 中文

图片理解沿用三角色 capability seam：`@deepseek-ai/dsh-vision` 是 Service Definition（`VisionProvider` 注册表 + 与注册顺序无关的 `understand()` 选择）；`@deepseek-ai/dsh-vision-openai` 是 Provider（多模态 `chat/completions`，携带凭据的请求拒绝重定向）；`@deepseek-ai/dsh-tool-vision` 是 Consumer（模型工具 `understand_image`）。

## 已放弃的部分

- 本地图片路径仅按扩展名识别（PNG/JPEG/WebP/GIF）后 base64 编码为 data URI；字节不做 magic 校验，错标格式的文件会原样交给 provider。
- Provider 响应体整体读入内存；seam 只对最终渲染文本用 `maxOutputChars` 做上限，不对原始响应字节设限。

## 必需的验证

- `packages/vision/vision/tests/vision.spec.ts` — provider 注册/销毁、重复拒绝、选择语义、`maxOutputChars` 截断。
- `packages/vision/vision-openai/tests/provider.spec.ts` — 多模态请求形态、重定向拒绝（不接触目标）、HTTP/JSON/内容缺失路径。
- `packages/vision/tool-vision/tests/understand.spec.ts` — 工具注册、`ctx.vision` 执行接线、本地路径经可选 `ctx.fs` 转 data URI。
- `packages/vision/tool-vision/tests/loader-composition.spec.ts` — REAL-composition 层：三个插件从 test-only `cordis.yml` 经真实 Loader + Include 启动，外部视觉 HTTP 调用被 mock，`understand_image` 用 data URI 出图、缺文件系统时拒绝本地路径。
