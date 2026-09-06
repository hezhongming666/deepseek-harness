# @deepseek-ai/dsh-ia-orchestrator

[English](README.md) | 中文

项目编排器（§3.10）：带"验证后闸门"流转的 DAG 阶段机、有界内环（§4.1）与升级包（§4.2）。项目按 id 隔离；编排器只从闸门引擎读回裁决，绝不裁决（§3.10 治理约束）。

## 配置

| 键 | 含义 |
|---|---|
| `template` | `initProject` 默认实例化的模板：`conveyor-line`。未知名称在加载时失败。 |
| `dataDir` | 项目状态持久化目录；默认空 = 仅内存。非空时加载期从 `<dataDir>/ia-orchestrator.json` 恢复全部项目，每次变更后原子快照。 |

## `conveyor-line` 模板

```
requirements ── design ── control-program ── simulation ── commissioning ── acceptance
```

| 阶段 | 验证器 | 闸门 |
|---|---|---|
| `requirements` | — | `requirement-baseline` |
| `design` | — | `design-review` |
| `control-program` | `st-syntax`、`st-lint`，可选 `tia-compile` | — |
| `simulation` | — | `release-review`（项目闸门） |
| `commissioning` | — | `first-power-on` |
| `acceptance` | — | `acceptance-signoff` |

可选验证器仅在某个提供方于组合好的验证器注册表中注册了该种类时运行；`tia-compile` 来自 `@deepseek-ai/dsh-ia-verifier-openness`，以真实 TIA Portal 编译裁决同一份提交。本地种类读提交的 `text`；`tia-compile` 读可选的 `vendorSource` 并回退到 `text`，因此一次提交同时携带供本地检查的 harness `PROGRAM` 方言与供厂商编译的 TIA SCL 块。

阶段状态：`pending → running → (repair ↺ | gated | passed | escalated)`。提交先运行绑定验证器；失败以报告返回 `repair`，直到重试预算（默认 3，§4.1）耗尽，随后阶段升级，附带上下文、产物、证据、失败摘要与监督者选项组成的升级包（§4.2）。绑定闸门使阶段停在 `gated`；批准则通过，驳回则回到 `running` 返工。

## Service API

`ctx.iaOrchestrator`：

- `initProject(projectId?, templateName?)` — 实例化项目；首个阶段从 `running` 开始。
- `project(projectId)` / `projectsList()` — 快照，先同步绑定的闸门裁决。
- `advance(projectId, stageId)` — 启动 `pending` 阶段；所有前驱必须已通过。
- `submit(projectId, stageId, submission)` — 运行验证器，然后过闸/通过、修复或升级。
- `resolveEscalation(projectId, stageId, instruction)` — 监督者路径：带着新预算与指示回到 `running`。任何面向模型工具都不暴露它。
- `exportAudit(projectId)` — §5.4 审计包：每个阶段的机器状态加上其绑定闸门的完整请求与裁决历史。
- `templatesList()` — 已注册模板名。

当一次提交在同一次内环运行中先失败后通过时，学习管线（§4.3）把该失败-修复对沉淀为可选知识服务里的一条 `pending-review` 案例；沉淀库的重复拒绝即去重闸门，任何沉淀库故障都不阻断已通过的阶段。

加载时服务对照组合好的注册表校验每个绑定的验证器种类，并注册 `release-review` 闸门——配置错误响亮失败。invariant 伴随插件在每次变更后证明阶段机：任何阶段不得先于未通过的前驱运行、尝试数不超过预算、升级阶段必带升级包、通过且绑定验证器的阶段只持有通过报告。

## 持久化

配置 `dataDir` 后，每次已提交的变更——项目实例化、推进、各分支的提交、升级解决，以及读取时折入的闸门裁决同步——都写一份原子版本化快照（`ia-orchestrator.json`）；全新启动恢复全部项目的阶段机、尝试数、最新报告、升级包、指示与项目 id 序号，并把每个阶段重新绑定到其模板节点。损坏或版本不符的快照在加载时失败；快照写入失败会抛错，而内存提交保留（磁盘可能落后于内存，直到下一次成功保存）。

## Model Experience

间接地，通过 dsh-tool-ia 的 `ia_project` 工具——这是驱动该 DAG 的唯一面向模型界面。

#### KV Cache effect

独立。编排器不持有请求作用域状态，不注册提示词或工具 schema；项目状态只作为 `ia_project` 工具结果进入请求。

## Known Limitations and Deferred Work

- **快照而非日志** — 持久化是每个数据目录一份原子 JSON 快照（fsync 崩溃持久性不在范围）；未配置 `dataDir` 时阶段状态保持内存，会话日志中工具可见的流转是唯一持久记录。
- **线性模板链** — 自定义 DAG 拓扑（并行的 hmi/电气阶段、运行闭环回灌）需要注册额外模板；目前只内置 `conveyor-line`。
- **升级解决仅限人工** — 任何规则都不能解决升级；监督者路径是 `resolveEscalation` 服务 API。
