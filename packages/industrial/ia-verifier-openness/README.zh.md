# @deepseek-ai/dsh-ia-verifier-openness

[English](README.md) | 中文

工业闭环的真实厂商编译通道：把 `tia-compile` 验证器种类注册进 `ctx.iaVerifiers`。每次绑定该种类的验证都会把提交的 TIA SCL 块经 Openness 桥导入所配置的 TIA 项目并编译——报告携带 TIA Portal 自己的错误/警告计数与消息，因此通过的裁决意味着厂商编译器接受了该块，而不是本地替身解析成功。本地检查仍是兜底：conveyor-line 模板始终运行 `st-syntax`/`st-lint`，仅在本插件挂载时才追加 `tia-compile`。

## 配置

| 键 | 含义 |
|---|---|
| `url` | 运行中 Openness 桥的绝对 http(s) URL，例如 `http://127.0.0.1:4281`（必填——缺失时加载失败）。 |
| `blockName` | 提交源码被导入为的 TIA 块名；默认 `IACheck`。必须是 TIA 标识符（字母或下划线开头，随后是字母、数字、下划线；最多 128 字符）。 |
| `requestTimeoutMs` | 每次请求的桥超时毫秒数；默认 300000。 |

## `tia-compile` 种类

| 字段 | 值 |
|---|---|
| kind | `tia-compile` |
| 输入 | TIA SCL 源码文本：带 `{ S7_Optimized_Access := 'TRUE' }`、`VERSION`、`VAR_*` 块与 `BEGIN ... END_FUNCTION` 的 `FUNCTION` 或 `FUNCTION_BLOCK` 定义——不是内置 ST 检查解析的 `PROGRAM` 方言。有 `vendorSource` 时读它，否则读 `text`，因此一次提交可同时携带两种方言。源码声明的块名必须与配置的 `blockName` 完全一致。 |
| 裁决 | 仅当编译器报告零错误时 `pass` 为 true；警告保持为建议性诊断。 |

报告诊断：`tia-compile-error` 与 `tia-compile-warning` 携带编译器的错误与警告消息（信息性编译行被丢弃）；`tia-compile-import-failed` 指名桥无法导入的块；`tia-compile-unavailable` 覆盖桥不可达、超时、infrastructure 或 killed 运行以及畸形的线缆响应；`tia-compile-empty-input` 在本地应答，不做桥往返。四条失败路径全部失败关闭——`pass` 保持 false，提交绝不会在损坏的通道上溜过。

## Model Experience

间接地，通过 dsh-tool-ia 的 `ia_verify` 与 `ia_project` 工具——它们渲染这些报告与阶段裁决。

#### KV Cache effect

独立。本插件不注册提示词或工具 schema，不持有请求作用域状态；报告文本只作为工具结果进入请求。

## Known Limitations and Deferred Work

- **每次挂载一个桥** — 验证器只指向一个 `url`，因此一次挂载只对一个 TIA 项目编译；多项目现场为每个项目 profile 各挂载一次插件。
- **整软件编译** — 桥编译整个 PLC 软件，因此草稿项目里任何其他有错误的块都会让每次验证失败；保持草稿项目干净，并预期具名块在每次验证时被覆盖。
- **无取消接缝** — 一次 verify 往返会跑到桥超时为止；spec-loop 适配器的 `/cancel` 路径未接在此处，因为验证没有面向调用方的取消契约。
