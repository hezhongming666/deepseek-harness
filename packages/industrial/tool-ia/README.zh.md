# @deepseek-ai/dsh-tool-ia

[English](README.md) | 中文

工业闭环的面向模型界面：五个工具，覆盖验证器、追溯、闸门、知识与编排器服务。权限边界是结构性的——任何 schema 都不暴露闸门裁决、知识批准或升级解决动作。

## 配置

| 键 | 含义 |
|---|---|
| `enabled` | 注册哪些工具；默认全部五个。省略的名字保持未注册。 |

## 工具

| 工具 | 界面 |
|---|---|
| `ia_verify(kind, source, vendorSource?, fileName?)` | 运行一个确定性验证器，返回带诊断与证据的通过/失败报告。外部编译种类（如 `tia-compile`）读取 `vendorSource`，缺省时回退到 `source`。 |
| `ia_trace(action, …)` | 对只追加追溯图执行 `record` / `link` / `change` / `impact` / `matrix`。 |
| `ia_gate(action, …)` | 仅 `list` / `request`；挂起请求走审批通道往返。 |
| `ia_knowledge(action, …)` | `search` / `record` / `readiness`；记录以 `pending-review` 入库。 |
| `ia_project(action, …)` | 对编排器 DAG 执行 `init` / `list` / `status` / `advance` / `submit`。 |

追溯与项目操作按调用 Agent 作用域化：追溯按 Agent 会话，项目按 Agent 并可用显式 `projectId` 覆盖。invariant 伴随插件证明已注册的 `ia_gate` schema 绝不暴露裁决动作。

## Model Experience

### ia_verify 工具

#### What the model sees

生成的 [`ia_verify` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-ia)：`kind` 枚举镜像已注册的验证器种类。结果是完整报告——`pass`、带位置的 `diagnostics` 与 `evidence`，不做任何摘要省略。

#### Token effect

工具可见时每个请求的 schema 成本固定；结果大小随产物诊断数增长，受模型提交的源码限制。

#### KV Cache effect

定义、可见性与已注册 `kind` 枚举不变时前缀稳定。注册额外验证器种类会改变枚举并可能使本 schema 的复用失效。

### ia_trace 工具

#### What the model sees

生成的 [`ia_trace` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-ia) 与五个动作。结果返回服务签发的节点 id（`node-<n>`）、三级影响摘要与带覆盖判定的矩阵行；无 Agent 的调用方被拒绝，因为图需要会话作用域。

#### Token effect

schema 成本固定；结果大小随返回的节点/矩阵行数增长，仅受项目已记录内容限制。

#### KV Cache effect

定义与可见性不变时前缀稳定。新增节点/边种类会改变枚举并可能使复用失效。

### ia_gate 工具

#### What the model sees

生成的 [`ia_gate` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-ia)，仅 `list`/`request` 动作——不存在裁决动作。`list` 返回每道闸门及其挂起数与最新裁决；`request` 返回已记录的请求、触发的规则裁决或审批通道结果，并在无应答者、请求保持挂起时给出显式提示。

#### Token effect

schema 成本固定；结果很小（闸门清单与一条裁决），与请求历史无关。

#### KV Cache effect

定义与可见性不变时前缀稳定。闸门清单由服务封闭，schema 不随请求活动漂移。

### ia_knowledge 工具

#### What the model sees

生成的 [`ia_knowledge` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-ia) 与 `search`/`record`/`readiness`。搜索命中始终携带 `source` 与 `version` 引用及 `matchedTerms`，低于冷启动规模时结果标记 `degraded: true`；`record` 返回新条目 id 及其 `pending-review` 状态。

#### Token effect

schema 成本固定；结果大小随命中数增长，受 `maxSearchResults` 封顶。

#### KV Cache effect

定义与可见性不变时前缀稳定；封闭的库枚举使 schema 独立于已记录内容。

### ia_project 工具

#### What the model sees

生成的 [`ia_project` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-ia) 与 `init`/`list`/`status`/`advance`/`submit`。快照渲染阶段状态、尝试数、闸门状态、最新验证报告、升级包与人工指示；`submit` 只返回更新后的阶段。

#### Token effect

schema 成本固定；结果大小随阶段数（内置模板六个）增长，失败提交时随报告大小增长。

#### KV Cache effect

定义与可见性不变时前缀稳定；阶段活动永不改变 schema。

## Known Limitations and Deferred Work

- **工具不读回原始产物** — `ia_project` 快照携带最新报告而非完整提交文本（升级包除外）；模型保留自己的工作副本。
- **每 Agent 仅当前项目** — `ia_project` 每 Agent 记住一个项目；多项目 Agent 显式传 `projectId`。
- **闸门裁决依赖组合好的应答者** — 无审批应答者时请求保持挂起且工具会明说；真实部署由 ACP 桥或 Web GUI 提供。
