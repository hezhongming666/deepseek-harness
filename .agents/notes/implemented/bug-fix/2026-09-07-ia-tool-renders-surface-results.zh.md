# Agent Note: ia 工具渲染层暴露规范结果

Status: implemented

[English](2026-09-07-ia-tool-renders-surface-results.md) | 中文

## Problem

`tool-ia` 的四个数据工具为每个动作声明了规范输出摘要——追溯节点 id、链接、三级影响清单、矩阵行、闸门清单、请求裁决、知识命中、记录、就绪度与项目快照——但每个 `render` 都用固定的 `done.` 文本替换了该摘要。模型永远看不到自己刚通过 `ia_trace record` 拿到的节点 id，因此下一步 `ia_trace link` 无法定位它（`unknown trace node`）；闸门清单、请求裁决、搜索命中与项目状态同样不可见，而工具 schema 与包 README 承诺的正是被渲染层丢弃的这些信息。

## Decision

每个数据工具现在通过共享的 `textBlock` 辅助函数把规范摘要渲染为纯文本行，且每个渲染都保持为已验证规范值的纯函数：

- `ia_trace`：`record` 渲染签发的节点 id 与 kind，`link` 渲染边，`change` 与 `impact` 渲染 changed/direct/indirect/potential id 清单，`matrix` 为每条需求渲染一行，含其实现与测试 id 及覆盖判定。
- `ia_gate`：渲染每道已注册闸门及其挂起数与最新裁决；请求渲染 decided 或 pending 的裁决结果并附挂起提示。
- `ia_knowledge`：搜索命中渲染条目 id、库、标题、source/version 引用、审核状态与匹配词，并附 `degraded` 冷启动标志；`record` 渲染新条目 id 及其审核状态；`readiness` 渲染各库计数与缺口。
- `ia_project`：渲染项目 id 与模板，每个阶段一行（状态、尝试数、验证器、闸门状态、报告、升级、指示），另渲染项目清单、提交后的阶段与逐阶段的审计包及其闸门裁决。

规范摘要不变：对结构化消费方仍是无损 JSON，只有呈现投影发生了改变。

## Alternatives considered

**把规范摘要直接序列化为 JSON 文本。** 否决：摘要已经以结构化值到达代码消费方；模型需要的是可操作字段——刚签发的节点 id、挂起裁决——以紧凑稳定的形式呈现，而非把一切重新列一遍、消耗 token 的序列化。

**改输出 schema 而不是渲染。** 否决：摘要本身正确，且与工具描述和 README 一致；缺陷在呈现投影丢弃了它，而这正是 `render` 钩子的职责。

**照搬 `ia_verify` 的单行风格。** 否决：验证报告是单面结果，而数据工具返回多行结构（闸门、矩阵行、阶段），只有逐行渲染才可读。

## Consequences

模型现在可以完成 schema 所描述的闭环：记录节点后立刻用渲染出的 id 建立链接，无需检查磁盘快照即可读到闸门请求的裁决，并在每次 `init`/`advance`/`submit` 后看到项目状态。渲染为确定性纯文本，回放与快照保持稳定。以后新增工具动作若未配渲染分支，会暴露 `unhandled render action` 而非静默报告成功。Loader 组合测试固定了 record/link/matrix、闸门清单与挂起请求、知识 record/search/readiness、项目 init/status/list/export 的渲染文本。

## Related

- [工业自动化闭环能力族](../architecture/2026-09-05-industrial-automation-closed-loop-family.md)
