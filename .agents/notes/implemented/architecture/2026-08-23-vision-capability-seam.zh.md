# Agent Note: 图片理解能力 seam（`ctx.vision`）

Status: implemented

[English](2026-08-23-vision-capability-seam.md) | 中文

## 问题

harness 没有图片理解能力：模型无法询问一张图片的内容。图片理解有三个所有者——模型需要稳定的工具 schema，harness 需要提供方选择与规范化结果，提供方需要多模态请求与响应处理。把工具直接焊死在某个具体提供方端点上，会把模型可见 schema 绑定到该端点。

## 决策

图片理解沿用三角色能力 seam：`@deepseek-ai/dsh-vision` 是 Service Definition（`VisionProvider` 注册表 + 与注册顺序无关的 `understand()` 选择）；`@deepseek-ai/dsh-vision-openai` 是 Provider（多模态 `chat/completions`，携带凭据的请求拒绝重定向）；`@deepseek-ai/dsh-tool-vision` 是 Consumer（模型工具 `understand_image`）。

## 已放弃的部分

- 本地图片路径仅按扩展名识别（PNG/JPEG/WebP/GIF）后 base64 编码为 data URI；字节不做 magic 校验，错标格式的文件会原样交给 provider。
- Provider 响应体整体读入内存；seam 只对最终渲染文本用 `maxOutputChars` 做上限，不对原始响应字节设限。

## 备选方案

**并入 web seam（`ctx.web`）。** web seam 的请求/结果词汇是 HTTP 搜索与抓取；vision 需要多模态 `chat/completions` 载荷与图片感知提供方。复用 `ctx.web` 会为一个能力所需的载荷形态加宽其约定。

**工具直接对接 OpenAI provider（无 seam）。** 绑定单一提供方端点的工具把模型可见 schema 钉死在该端点，并在每次集成中重复选择与可用性处理；seam 让 schema 保持稳定，提供方在 `ctx.vision` 之后插拔。

**复用 `dsh-tool-fs` 的 `read_image`。** `read_image` 以附件为作用域，且只在被路由模型声明图片输入时执行；`understand_image` 接受显式 URL、data URI 或本地路径引用，不需要附件存储，两个工具服务于不同的调用形态。

## 必需的验证

- `packages/vision/vision/tests/vision.spec.ts` — provider 注册/销毁、重复拒绝、选择语义、`maxOutputChars` 截断。
- `packages/vision/vision-openai/tests/provider.spec.ts` — 多模态请求形态、重定向拒绝（目标从未被接触）、HTTP/JSON/内容失败路径。
- `packages/vision/tool-vision/tests/understand.spec.ts` — 工具注册、`ctx.vision` 执行接线、本地路径经可选 `ctx.fs` 转 data URI。
- `packages/vision/tool-vision/tests/loader-composition.spec.ts` — REAL-composition 层：三个插件从 test-only `cordis.yml` 经真实 Loader + Include 启动，外部视觉 HTTP 调用被 mock，`understand_image` 用 data URI 出图、缺文件系统时拒绝本地路径。

## 后果

harness 获得一个架在顺序无关提供方注册表上的模型工具 `understand_image`：新提供方插拔时不改工具 schema，选择失败是模型可以路由的强类型 `VisionError`。代价是上面两条边界——错标文件与超大响应分别直达 provider 与内存。
