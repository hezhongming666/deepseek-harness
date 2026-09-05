# Agent Note: TIA Portal 编译作为 Openness 桥之上的验证器

Status: implemented

[English](2026-09-05-industrial-verifier-openness-bridge.md) | 中文

## Problem

工业族交付了本地确定性验证器（`st-syntax`/`st-lint`），但没有真实厂商编译，控制程序可能在 TIA Portal 本身会拒绝它的情形下通过阶段。Openness 桥（`packages/spec-loop/provider-openness`）已能通过其 `/run` verify 动作提供真实 TIA Portal 编译，但 spec-loop 适配器 seam 是参数搜索循环——它无法把裁决报告喂进编排器绑定阶段所用的验证器注册表。

## Decision

**新增 `industrial/ia-verifier-openness` 包，把 `tia-compile` 种类注册进 `ctx.iaVerifiers`。** 该种类把提交的 TIA SCL 块经桥的 `/run` verify 动作导入所配置的 TIA 项目并编译；报告携带 TIA Portal 自己的错误/警告计数与消息。本地检查仍是兜底：conveyor-line 模板把 `tia-compile` 列在新的 `optionalVerifiers` 槽位里，因此它只在种类已注册时运行——`st-syntax`/`st-lint` 始终运行。

**处处失败关闭。** 桥不可达、超时、infrastructure 或 killed 运行、畸形的线缆响应一律给出 `pass: false` 与 `tia-compile-unavailable` 诊断；桥无法导入的块给出 `tia-compile-import-failed`；空提交在本地应答（`tia-compile-empty-input`）而不做往返——这也让注册表的空输入 invariant 探针保持离线。`url` 为必填并在加载时失败，因此包按部署挂载（profile patch 或 `cordis.openness.yml` 覆盖层），绝不进 `dsh-ia` bundle。

**线缆上的逐消息严重级别。** TIA 的 `CompilerResultMessage.State`（`CompilerResultState`）被展平为与 `compileMessages` 平行的 `compileMessageStates` 数组；TypeScript 解析器对旧桥回退到按计数前缀归属（前 `compileErrors` 条为错误）。假桥发出同样的字段，于是两条通道在同一座物理桥上共享同一份线缆契约。

**一次提交，两个显式来源。** 两种方言没有任何交集文本——本地检查解析 harness 的 `PROGRAM` 子集，TIA SCL 使用 `FUNCTION`/`FUNCTION_BLOCK`。`VerificationInput` 与 `Submission` 因此携带可选的 `vendorSource`：本地种类读 `text`，`tia-compile` 读 `vendorSource` 并回退到 `text`。这是显式的第二来源，不是翻译器——没有代码把任一方言改写为另一方，省略 `vendorSource` 的提交仍可经直接 `ia_verify` 调用原样编译。提交的 TIA SCL 块名必须与配置的 `blockName` 完全一致。

## Alternatives considered

- **改用 spec-loop 适配器** — 该 seam 的 validate/run 结果是循环迭代词汇，不是裁决报告；编排器将不得不引入 spec-loop 机制来绑定一个阶段验证器。
- **把包打进 `dsh-ia` bundle** — 必填的 `url` 会让每个没有桥的部署在加载时崩溃；静默无操作默认值则违反失败响亮的配置原则，并让阶段永远卡在一个永久不可用的可选验证器上。
- **给 `ia-verifier` 加桥客户端** — 把注册表包绑死在一家厂商上，并把网络 I/O 拖进每个纯本地部署的加载路径。
- **在适配器里做方言翻译器** — 把 harness 的 `PROGRAM` 文本改写成 TIA SCL（或反向）会把单一事实来源藏在有损变换之后，并让厂商实际编译的内容偏离本地检查看到的内容；显式的第二来源让两份产物都保持诚实。
- **无严重级别的线缆** — 复用现有编译结果会迫使验证器从计数猜测逐消息严重级别；发出 `compileMessageStates` 让裁决证据精确，同时保留旧桥回退。

## Consequences

得到：闭环的 §2.3"真实编译裁决"端到端存在——注册表种类、可选阶段绑定、`vendorSource` 第二来源接缝、失败关闭报告，以及对 TIA Portal V21 验证过的活通道：携带两种方言的控制程序提交三份报告全绿通过，TIA SCL 引用未定义标签的提交则以编译器自己的消息失败。未挂载桥时本地兜底原样保留。

代价：每个部署多挂载一个包；桥编译整个 PLC 软件，因此草稿项目里任何其他有错误的块都会让每次验证失败，且具名块每次运行都会被覆盖；一次 verify 往返会跑到桥超时为止，没有面向调用方的取消接缝。
