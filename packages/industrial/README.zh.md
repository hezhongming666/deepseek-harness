# industrial/ — 工业自动化闭环能力族

[English](README.md) | 中文

工业自动化闭环架构（[设计 v1.1](../../design-proposals/industrial-automation-ai-agent-closed-loop-architecture.md)）的插件实现：确定性的"验证即门禁"裁决、带 A0–A3 自动化等级的强制人工闸门、只追加追溯与三级影响分析、冷启动门控知识库，以及 DAG 项目编排器。设计章节到包的映射：

| 设计机制 | 包 |
|---|---|
| §2.3 验证即门禁 / §7.2 确定性验证器 | [`ia-verifier/`](ia-verifier/README.md) |
| §4.4/§6.1 追溯与影响分析 | [`ia-trace/`](ia-trace/README.md) |
| §5.1/§5.2 闸门与自动化分级 | [`ia-gates/`](ia-gates/README.md) |
| §6.2/§4.3 知识库与学习沉淀 | [`ia-knowledge/`](ia-knowledge/README.md) |
| §3.10/§4.1/§4.2 DAG 编排、内环与升级 | [`ia-orchestrator/`](ia-orchestrator/README.md) |
| §3 L3/L5 Agent 界面 | [`tool-ia/`](tool-ia/README.md) |

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`ia-verifier/`](ia-verifier/README.md) | 确定性验证器注册表，内置结构化文本语法/Lint 与 IO-符号一致性验证器 | `ctx.iaVerifiers` |
| [`ia-verifier-openness/`](ia-verifier-openness/README.md) | 真实厂商编译通道：注册 `tia-compile` 种类，经 Openness 桥以 TIA Portal 编译裁决 TIA SCL | 扩展 `ctx.iaVerifiers` |
| [`ia-trace/`](ia-trace/README.md) | 只追加追溯图：节点、类型化边、变更记录、三级影响分析、需求矩阵 | `ctx.iaTrace` |
| [`ia-gates/`](ia-gates/README.md) | 闸门引擎：六道强制人工闸门、A0–A3 分级、恒人工危险闸门、审批通道裁决 | `ctx.iaGates` |
| [`ia-knowledge/`](ia-knowledge/README.md) | 标准/模板/案例库，强制出处引用、冷启动就绪、学习沉淀 | `ctx.iaKnowledge` |
| [`ia-orchestrator/`](ia-orchestrator/README.md) | 输送线 DAG 阶段机：验证后闸门流转、有界内环修复、升级包 | `ctx.iaOrchestrator` |
| [`tool-ia/`](tool-ia/README.md) | 面向模型的 `ia_verify`/`ia_trace`/`ia_gate`/`ia_knowledge`/`ia_project` 工具 | 注册到 `ctx.tools` |

组合顺序只通过声明依赖生效：`ia-orchestrator` 需要 `iaVerifiers` 与 `iaGates`，`tool-ia` 需要全部五个服务。[`dsh-ia` bundle](../bundle/ia/README.md) 与 [industrial-ia 示例](../../examples/industrial-ia/README.md) 提供完整组合。

权限边界是结构性的：任何工具 schema 都不暴露闸门裁决、知识批准或升级解决动作——这些只存在于服务内的人工/规则通道。
