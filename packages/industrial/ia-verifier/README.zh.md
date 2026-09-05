# @deepseek-ai/dsh-ia-verifier

[English](README.md) | 中文

工业闭环的确定性裁决层：一个具名验证器注册表，其裁决是输入的纯函数——无模型调用、无时钟或环境读取，同一产物永远得到同一份报告。这是架构"模型生成、系统裁决、人类把关"中"系统裁决"的一半。

## 配置

| 键 | 含义 |
|---|---|
| `builtins` | 加载时启用的内置验证器种类；默认 `[st-syntax, st-lint, io-consistency]`。未知条目在加载时失败。 |

## 服务 API

`ctx.iaVerifiers`：

- `register(descriptor)` — 注册一个具名验证器；返回移除用的 disposer。重复种类抛 `DuplicateVerifierError`。
- `kinds()` — 按注册顺序返回已注册种类。
- `get(kind)` — 返回描述符，未注册时为 `undefined`。
- `verify(kind, input)` — 运行一次检查；未注册种类抛 `UnknownVerifierError`（验证绝不静默跳过）。
- `verifyAll(kinds, input)` — 按顺序对同一输入运行多个检查。

`VerificationReport` 为 `{ kind, pass, diagnostics, evidence }`；仅当存在 severity 为 `'error'` 的诊断时 `pass` 为 false。invariant 伴随插件用空输入探针为每个已注册验证器证明该一致性。

## 内置验证器

| 种类 | 输入 | 检查内容 |
|---|---|---|
| `st-syntax` | IEC 61131-3 结构化文本源码 | 对文档化 ST 子集做确定性词法 + 递归下降语法检查；每个词法/语法问题带一基行列位置报告。 |
| `st-lint` | 结构化文本源码 | 名称解析与卫生：未定义引用（错误）、重复声明（错误）、未知具名类型（错误）、循环外的循环控制（错误）、未使用变量（警告）。 |
| `io-consistency` | JSON 文档 `{ "io": [{ "tag", "address" }], "symbols": [{ "name" }] }` | IO 清单 ↔ 符号表双向一致性：重复 tag/地址/名称与缺失符号为错误，孤儿符号为警告。 |

支持的 ST 子集覆盖 `PROGRAM`/`FUNCTION_BLOCK` 与 `VAR` 块、`AT` 地址、基本/数组/具名类型、赋值、调用、`IF/ELSIF/ELSE`、带多标签分支的 `CASE`、`FOR/WHILE/REPEAT` 循环、`EXIT/CONTINUE/RETURN`、含 `**` 与 `NOT` 的完整表达式优先级、数组索引、嵌套 `(* *)` 注释与 `''` 字符串转义。子集之外的厂商特有语法一律报错，绝不静默接受——设计的"宁可人工也不可假自动"。

扩展提供方注册更多种类；随附的 `@deepseek-ai/dsh-ia-verifier-openness` 注册 `tia-compile`，经 Openness 桥以真实 TIA Portal 编译裁决 TIA SCL 源码。

## Model Experience

间接地，通过 dsh-tool-ia 的 `ia_verify` 工具——这是渲染这些报告的唯一面向模型界面。

#### KV Cache effect

独立。注册表不持有请求作用域状态，不注册提示词或工具 schema；报告文本只作为 `ia_verify` 工具结果进入请求。

## Known Limitations and Deferred Work

- **无本地厂商编译器** — `st-syntax` 是本地替身，不是 TIA/CODESYS 编译；兄弟包 `@deepseek-ai/dsh-ia-verifier-openness` 经 Openness 桥把真实 TIA Portal 编译绑定为额外的 `tia-compile` 种类。
- **单文本提交模型 + 厂商接缝** — `verifyAll` 把同一份输入喂给所有绑定种类：本地种类读 `text`，外部编译种类（如 `tia-compile`）读可选的 `vendorSource`，缺省时回退到 `text`。一次提交因此可同时携带供本地检查的 harness `PROGRAM` 方言与供真实厂商编译的 TIA SCL 块；io-consistency 检查仍经 `ia_verify` 独立运行。
- **ST 子集是封闭的** — 不解析 `FUNCTION` POU、`VAR_GLOBAL/RETAIN`、结构类型、方法调用与指针/解引用语法；使用这些语法的源码响亮失败，而不是被猜测。
