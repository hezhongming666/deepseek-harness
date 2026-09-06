# @deepseek-ai/dsh-ia-gates

[English](README.md) | 中文

闸门引擎——架构的人机边界（§5.1/§5.2）。六道强制人工闸门随服务内置，不可移除或重注册；危险闸门在任何自动化等级下都保持人工；裁决只经人工审批通道或在 A2/A3 生效的已注册自动放行规则进入。Agent 只能请求闸门，绝不裁决。

## 配置

| 键 | 含义 |
|---|---|
| `level` | 部署自动化等级 `A0`–`A3`，默认 `A1`（§5.1）。其他值在加载时失败。 |
| `dataDir` | 闸门引擎状态持久化目录；默认空 = 仅内存。非空时加载期从 `<dataDir>/ia-gates.json` 恢复请求与裁决，每次变更后原子快照。 |

## 六道强制闸门

| id | 恒人工 |
|---|---|
| `requirement-baseline` | 否 — A2/A3 允许自动放行规则 |
| `design-review` | 否 — A2/A3 允许自动放行规则 |
| `sil-review` | 是 — 资质工程师签字 |
| `first-power-on` | 是 — 任何等级下的危险操作 |
| `acceptance-signoff` | 是 |
| `online-change` | 是 — 影响生产在线的变更 |

## Service API

`ctx.iaGates`：

- `automationLevel()` — 配置的等级。
- `registerGate(definition)` — 添加项目闸门；强制 id 保留。返回移除 disposer。
- `registerAutoReleaseRule(id, gateId, rule)` — 注册确定性放行谓词；指向恒人工闸门抛 `AlwaysHumanGateError`。
- `gatesList()` / `requests()` / `requestsFor(gateId)` — 定义与只追加请求记录。
- `request(gateId, requestedBy, context)` — 请求一道闸门；A2/A3 下已注册规则立即裁决，否则请求保持挂起。
- `requestHumanDecision(gateId, agent)` — 就最新挂起请求走组合好的审批通道：`allowed-once` 批准、`rejected` 驳回、其余保持挂起（失败关闭）。
- `latestDecision(gateId)` — 最新裁决（若存在）。

没有公开的裁决方法：唯一裁决路径是审批通道与规则求值，都在服务内部。invariant 伴随插件证明强制清单、其固定的恒人工分类，以及恒人工闸门绝不由规则裁决。

## 持久化

配置 `dataDir` 后，每次已提交的变更——请求与裁决——都写一份原子版本化快照（`ia-gates.json`）；全新启动恢复全部请求与裁决以及请求序号。闸门定义与自动放行规则是注册效果（代码），绝不持久化：其所有者在启动时重新注册，因此重新注册的闸门直接延续其恢复的请求历史。损坏或版本不符的快照在加载时失败；快照写入失败会抛错，而内存提交保留（磁盘可能落后于内存，直到下一次成功保存）。

## Model Experience

间接地，通过 dsh-tool-ia 的 `ia_gate` 工具——这是唯一面向模型界面，且只暴露 request/list 动作。

#### KV Cache effect

独立。引擎不持有请求作用域状态，不注册提示词或工具 schema；闸门状态只作为 `ia_gate` 工具结果进入请求。

## Known Limitations and Deferred Work

- **快照而非日志** — 持久化是每个数据目录一份原子 JSON 快照（fsync 崩溃持久性不在范围）；未配置 `dataDir` 时状态保持内存，审批通道的审计事件是唯一持久记录。
- **规则放行是服务级而非项目级** — A2 标准项目作用域（按项目模板配规则）已延后；当前规则服务级生效。
- **恒人工闸门无审批策略覆盖** — 即使 `never` 审批策略也会让这些闸门保持挂起；须由审批 seam 之外的人工通道驱动。
