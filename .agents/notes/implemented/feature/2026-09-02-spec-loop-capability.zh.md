# Agent Note: spec-loop 能力——作为模型工具的确定性参数搜索

Status: implemented

[English](2026-09-02-spec-loop-capability.md) | 中文

## Problem

壳层/核层分工需要一个承担批量参数搜索的确定性核层：DSH（壳层）负责选择 spec、调度、汇报并与人类交互，而针对外部工程软件的核层闭环批量生成并评估候选参数——可回放、有界、零人工、成本封顶。闭环需要一个 spec 契约（目标 + 数值断言作为验收）、把可修复的断言未达标与输入非法、发散、基础设施故障分开的失败分级、带 ε 裕量的单调修复，以及迭代数/墙钟/Token 三重封顶。模型可见面是一个工具调用：跑完整个闭环并返回完整审计轨迹。

## Decision

新分组 `packages/spec-loop`，含三个包。`@deepseek-ai/dsh-spec-loop` 拥有闭环本身：`runSpecLoop`（确定性引擎）、`validateSpec` + `SpecLoopError('INVALID_SPEC')`（传输边界 spec 校验器）、品牌化的 `SpecLoopRunId`，以及 `SpecLoopAdapterService`（ctx 键 `specLoopAdapter`）——工业软件集成方实现的适配器 seam（`validate` 是廉价的 S1 关卡，`run` 携带取消信号执行并报告 `success`/`diverged`/`infrastructure`/`killed` 及结构化指标、许可证时长与版本四元组）。`@deepseek-ai/dsh-tool-spec-loop` 注册 `spec_loop` 工具并通过 LLM seam 负责生成：必填的有序 `models` 回退链（每个提案依次尝试每个目标）、部署上限（`maxIterations`/`maxWallClockMs`/`maxTokens` 及每次调用边界），以及有界的渲染报告。`@deepseek-ai/dsh-provider-openness` 由 [Openness provider 笔记](2026-09-04-openness-spec-loop-adapter.md) 加入，经 HTTP JSON 桥随附 TIA Portal Openness 适配器。

每个候选参数被唯一归类：`satisfied`、`S0`（断言未达标——唯一可修复的类别）、`S1`（包络或校验拒绝；绝不触达软件）、`S2`（发散）、`S3`（适配器抛错或报告基础设施故障）、`generation-failed`（所有回退模型均失败）或 `cancelled`。单调修复只在改进超过 `repair.margin` 时替换当前最优；连续 `maxNoImprovement` 次未改善停止闭环，连续 `maxConsecutiveInfrastructure` 次 S3 与迭代数/墙钟/计费 Token 预算（spec 预算与部署上限的较小值）同样如此。报告携带完整逐迭代审计轨迹、最优已验收候选与汇总成本。全部记账都是生成与适配器结果序列的纯函数，因此回放就是让生成器回放已记录提案的一次运行——引擎无需回放模式。

文档：[docs/subsystems/spec-loop.md](../../../../docs/subsystems/spec-loop.md) 拥有词汇表及其生成的 Cordis API 区域；工具 schema 位于生成的 [tool catalog](../../../../docs/tool-catalog.md#deepseek-aidsh-tool-spec-loop)。

## Alternatives considered

**为何不复用 workflow 引擎（模型编写脚本 + subagent）？** 脚本将拥有闭环控制流，但 spec-loop 的全部价值在于闭环形态、失败路由与预算强制是固定且可测的；生成是带回退链的一次结构化 JSON 模型调用，而非全新的子 agent。

**为何不让生成走 subagent provider？** 比实际需求更重：候选提案每次迭代只需一个有界 JSON 回复，多模型回退需要直接的 LLM seam 调用与逐次用量记账；subagent 引入闭环用不到的子会话与深度策略。

**为何不做带名称的适配器 provider 注册表？** 每个上下文一个适配器，正对应每个部署一套软件；注册表引入的选路策略目前无人消费。第二个适配器通过插件配置替换第一个。

**为何不随包发布 CLI 适配器 provider？** 能力发布时没有部署方拥有它；测试使用确定性的进程内假实现，未挂载 `specLoopAdapter` 时工具会响亮失败。[Openness provider](2026-09-04-openness-spec-loop-adapter.md) 后来随附了 HTTP 桥 provider；stdio CLI provider 与遥测解析仍属延期。

## Consequences

获得：以单一模型工具形式挂载的有界、可回放搜索闭环；S1/S2/S3 与可修复的 S0 分离；带 ε 裕量的单调最优跟踪；被部署上限收紧的 spec 预算；逐迭代审计轨迹与汇总成本报告；适配器 provider 以结果状态而非异常报告故障。

放弃：无遥测流提前终止（适配器可用返回 `diverged` 近似）；许可证时长只汇总报告、不针对池强制；预算按次运行（无持久化每日台账）；spec 每次调用内联传入（无命名注册表）；包络违规归类为 S1，无闭环中途人工审批；工具接入示例覆盖层（`examples/openness-spec-loop/cordis.yml`）并配有一次组装 Web keyless e2e（`apps/web/tests/openness-spec-loop.e2e.ts`），而非带模型 key 的快照，因为录制需要 API key——Loader 组合测试、agent 栈集成测试与 Web e2e 即真实组合覆盖。工具目录与 cordis 目录目前因在途 vision 包拥有的两个缺口（其缺失的目录清单与 `LINK_MAP` 条目）而无法完整重新生成，与本能力无关。
