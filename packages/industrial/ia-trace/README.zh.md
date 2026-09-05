# @deepseek-ai/dsh-ia-trace

[English](README.md) | 中文

工程闭环的只追加追溯图：需求/设计/实现/测试/变更节点、类型化有向边、变更记录，以及架构 §4.4 的三级变更影响分析。项目按调用方自选的 scope 键隔离——工具消费方使用 Agent 的会话 id，因此跨项目泄漏在构造上不可能（§3.10）。

## Service API

`ctx.iaTrace`：

- `project(scope)` — 打开（或复用）一个 scope 键下的隔离项目。
- `hasProject(scope)` — 该 scope 是否已有项目。
- `onProjectOpen(listener)` — 每个新项目的钩子，供 invariant 伴随插件使用。

`TraceProject`：

- `addNode({ kind, title, detail?, tags?, author, basis? })` — 记录一个节点；id 由服务签发为 `node-<n>`。
- `addLink(from, to, kind)` — 添加一条类型化边（`derives` | `implements` | `verifies` | `changes`）；未知端点与重复边抛错。
- `recordChange({ nodeIds, author, reason })` — 递增被触及节点的变更版本，追加记录，并返回正向影响分析。
- `impactOf(nodeIds)` — 三级：`direct`（直接后继）、`indirect`（更深的传递后继）、`potential`（共享标签但不可达——仅提醒，模型辅助 + 人工确认）。
- `matrix()` — 每条需求的可达实现与测试，以及覆盖判定。
- `nodesList()` / `linksList()` / `changesList()` — 完整快照。

节点、边与变更记录只增不改——取代通过新的变更记录发生，绝不编辑。invariant 伴随插件在每次提交后证明：边引用存在的节点，且每个节点的 `changeVersion` 等于其变更记录数。

## Model Experience

间接地，通过 dsh-tool-ia 的 `ia_trace` 工具——这是渲染该图的唯一面向模型界面。

#### KV Cache effect

独立。图不持有请求作用域状态，不注册提示词或工具 schema；追溯内容只作为 `ia_trace` 工具结果进入请求。

## Known Limitations and Deferred Work

- **内存项目** — 项目随服务生命周期存续，重启后不持久；会话日志通过 `tool/result` 记录每次工具可见的变更，但基于 storage-domain 的持久追溯存储已延后。
- **潜在影响是标签启发式** — 共享标签之外的语义关联正是设计中"模型辅助 + 人工确认"的一级，因此 `potential` 仅为提醒。
- **无跨项目查询** — 服务不提供跨 scope 键的并集或搜索，符合按项目隔离的规则。
