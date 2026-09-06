# Agent Note: 工业状态持久化与学习管线

Status: implemented

[English](2026-09-05-industrial-state-persistence-learning-pipeline.md) | 中文

## Problem

符合性审计发现工业族相对 v1.1 设计的最大偏差：§5.5 状态持久化。项目、追溯图、闸门裁决与知识条目只存内存，进程重启即抹掉阶段机、裁决历史与知识库；§5.4 的按项目审计包与 §4.3 的自动学习管线同样缺失。

## Decision

**每个有状态服务以 `dataDir` 配置启用版本化 JSON 快照。** `ia-gates`、`ia-knowledge`、`ia-trace`、`ia-orchestrator` 各增 `dataDir`（默认空 = 仅内存）。非空时构造器从 `<dataDir>/<service>.json` 同步恢复，每次已提交的变更经 `dsh-atomic-write` 新增的共享助手 `readJsonSnapshot`/`writeJsonSnapshot` 写一份原子快照（独占临时文件 + rename、版本校验、损坏或漂移响亮失败）。快照写入失败在内存提交后抛错——磁盘可能落后内存直到下一次成功保存，逐包文档写明。快照而非日志：fsync 崩溃持久性不在范围。

**注册效果绝不持久化。** 闸门定义与自动放行规则是代码；所有者在启动时重新注册，恢复出的闸门直接延续其恢复的请求历史。恢复出的编排器阶段重新绑定到其模板节点，读取时折入的闸门裁决同步同样落盘。

**审计包导出。** `exportAudit(projectId)` 汇集 §5.4 审计包：每个阶段的机器状态加上其绑定闸门的完整请求-裁决历史；`ia_project` 工具新增 `export` 动作。

**学习管线。** 提交在同一次内环运行中先失败后通过时，编排器把该失败-修复对经 `ctx.get`（可选服务，绝不注入）沉淀为 `ctx.iaKnowledge` 里的一条 `pending-review` 案例；沉淀库的重复拒绝即去重闸门，任何沉淀库故障都被吞掉——草稿沉淀绝不阻断已通过的阶段。

## Alternatives considered

- **走 storage hub（`ctx.storage`）** — 真后端与数据表单已存在，但让四个服务经 hub 会迫使每个部署再组合 storage 加后端，而这族功能本应独立可用；加载期同步恢复也排除了 hub 的异步 IO。
- **持久化闸门定义** — 每次启动都冲突：编排器重新注册 `release-review`，任何重新注册项目闸门的部署都会撞上恢复出的重复定义。定义是注册效果；只有请求与裁决是数据。
- **用翻译器或假仿真器替代诚实接缝** — 方言分工继续由显式 `vendorSource` 第二源承接，仿真阶段在出现真实仿真目标前仍以人工 release-review 为闸门。

## Consequences

得到：四类状态存储的重启存续、可导出的审计链、带去重的自动学习沉淀——审计的三个缺口全部闭合，137 项包级测试、含跨启动恢复段的 23 项装配冒烟、全部门禁通过。

代价：多一块共享工具面；持久化按部署显式启用（`dataDir`），未配置的 profile 保持原内存语义；快照原子但不 fsync。
