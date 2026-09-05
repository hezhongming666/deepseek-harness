# Agent Note: 工业自动化闭环作为 dsh 能力族

Status: implemented

[English](2026-09-05-industrial-automation-closed-loop-family.md) | 中文

## Problem

工业自动化设计（design-proposals/工业自动化AI-Agent闭环架构-v1.1.docx 及其 Markdown 孪生版）规定了一个多 Agent 工程闭环，其核心纪律是治理而非生成：确定性的"验证即门禁"裁决（§2.3）、带 A0–A3 自动化等级的强制人工闸门（§5.1/§5.2）、只追加追溯与三级变更影响分析（§4.4）、冷启动门控知识库（§6.2），以及带内环预算与升级包的 DAG 编排器（§3.10/§4）。harness 没有实现这些纪律的能力族，现有扩展面（spec-loop 的参数搜索引擎、审批 seam）也不覆盖它们。

## Decision

**新增 `industrial/` 能力族：五个服务、一个验证器提供方加一个工具包。** 设计机制与包一一对应：`ia-verifier`（确定性验证器注册表，内置 ST 语法/Lint 与 IO-符号一致性验证器）、`ia-verifier-openness`（`tia-compile` 种类，经 Openness 桥以真实 TIA Portal 编译裁决——见[桥集成记录](2026-09-05-industrial-verifier-openness-bridge.md)）、`ia-trace`（只追加节点/边/变更图与三级影响分析）、`ia-gates`（六道强制闸门、A0–A3 分级、恒人工危险闸门）、`ia-knowledge`（标准/模板/案例库，强制引用与冷启动就绪）、`ia-orchestrator`（输送线 DAG 阶段机，验证后闸门流转、重试预算 3、升级包）与 `tool-ia`（五个面向模型工具）。`dsh-ia` bundle 与 `examples/industrial-ia` 覆盖层提供完整组合；openness 验证器不进 bundle，因为其 `url` 由部署方持有且为必填。

**权限边界是结构性的，而非流程性的。** 任何工具 schema 都不暴露闸门裁决、知识批准或升级解决动作；闸门引擎根本没有公开的裁决方法——裁决只经组合好的审批通道（`ctx.approval`，缺失时失败关闭）或在 A2/A3 生效的已注册自动放行规则进入。工具包的 invariant 伴随插件证明已注册的 `ia_gate` schema 永不长出裁决动作。

**确定性验证器自持且本地。** ST 子集词法/解析器与 Lint/IO 检查是纯 TypeScript，无外部工具依赖，恪守设计的"验证器自持、本地化、不依赖模型"与"不具备自动化接口的环节宁可人工也不可假自动"：仿真阶段没有假验证器——它以人工发布评审为闸门。

**内存域状态 + 工具结果日志。** 追溯项目、闸门请求、知识条目与编排器项目随服务生命周期存续；一切模型可见内容都经工具结果流出，而工具结果由会话日志记录，因此"模型可见即已记录"的不变量在不触碰 `SessionEventMap` 的前提下成立。按项目持久化（§5.5）是各 README 的延后事项清单。

## Alternatives considered

- **扩展 spec-loop** — 其适配器 seam 是对单一软件集成的参数搜索循环，不是具名裁决检查的注册表；闸门/追溯/知识纪律在那里无处安放。
- **会话事件支撑的域存储** — 会把项目数据放进对话日志，并需要 `SessionEventMap` 增补与两套 SDK 投影更新；工具结果日志已用几分之一的界面满足模型可见性不变量。
- **单一 `dsh-ia` 巨石包** — 五个服务有彼此独立的消费方（工具包组合它们，编排器绑定其中两个）与独立生命周期；单包会把五个 ctx 键及其 invariant 并成一个发布单元。
- **验证器族拆分 provider 包** — 在尚无第二个 provider 的今天，单独的 ST provider 包只是徒增 seam 仪式；注册表 API 就是厂商编译适配器接入的扩展点。已由 `ia-verifier-openness` 实现：一旦真实 TIA 编译提供方存在，它就以独立包形式发布并注册 `tia-compile` 种类，注册表保持 provider 无关。

## Consequences

得到：闭环纪律以可组合、可独立测试的服务存在（94 个包级测试，含真实 Loader 装配）；部署是一组 bundle 行或一个覆盖层；每一次闸门放行都证明无法从模型界面触达。

代价：内存状态重启即失（各包已记录）、本地 ST 验证器是子集检查器——真实厂商编译是独立的 `tia-compile` 通道、默认 DAG 是线性六阶段模板——自定义拓扑是明确的扩展点而非已交付的广度。
