# @deepseek-ai/dsh-spec-loop

[English](README.md) | 中文

确定性 spec-loop 核心：在 spec 契约之上运行有界、可回放的候选搜索引擎，外加工业软件集成实现的适配器 seam。面向模型的行为位于 [`dsh-tool-spec-loop`](../tool-spec-loop/README.md)。

## 引擎

`runSpecLoop(request)` 按 validate → execute → assert 迭代执行，直到 spec 终止本次运行。每个候选参数恰好归入下列判定之一：

| 判定 | 含义 | 循环策略 |
| :--- | :--- | :--- |
| `satisfied` | 全部断言通过 | 接受为最优并停止 |
| `S0` | 运行成功但断言失败 | 单调修复：仅在改进超出 spec 的 `repair.margin` 时替换最优；连续 `maxNoImprovement` 次未改进即停止 |
| `S1` | 违反包络边界或 `adapter.validate` 拒绝 | 记录原因并再次提议；参数从不进入软件 |
| `S2` | 适配器报告发散 | 记录并把发散诊断放进历史后再次提议 |
| `S3` | 适配器抛错或报告基础设施故障 | 连续 `maxConsecutiveInfrastructure` 次故障即停止 |
| `generation-failed` | 生成器抛错（所有回退模型耗尽） | 以状态 `failed` 停止 |
| `cancelled` | 中止信号结束了适配器运行 | 以状态 `cancelled` 停止 |

终止状态：`satisfied`、`budget-limited`（迭代、墙钟或计费 Token）、`no-improvement`、`infrastructure-failed`、`failed`、`cancelled`。

预算是 spec 预算与可选部署 `ceilings` 的较小值；Token 统计按计费输入（未缓存 + 缓存读取 + 缓存写入）加输出计。license 时间从适配器结果累加并写入 `costs.licenseMs`，引擎从不在此强制。

## 确定性与回放

全部记账 — 迭代编号、单调最优跟踪、计数与成本 — 都是结果序列的纯函数。引擎在两次运行之间不持有任何状态。回放是一次由生成器回喂已记录提案（而非调用模型）、面向脚本化适配器的运行；引擎无需回放模式。

## 适配器 seam

`SpecLoopAdapterService`（ctx 键 `specLoopAdapter`）是软件集成实现的 Service Definition：

- `validate(params)` — 廉价的 S1 门禁：在不消耗 license 或资源的前提下拒绝不可行参数。
- `run(request)` — 执行一个候选参数；以 `success`/`diverged`/`infrastructure`/`killed` 结果报告结构化指标（`result`）、可选 `licenseMs`、`error`，以及用于审计轨迹的版本元组 `environment`（`softwareVersion`、`solverVersion`、`licenseServerVersion`、`osKernel`）。

提供方通过结果状态而非抛错报告求解器与基础设施故障；引擎仍会把适配器抛出的错误归类为 S3。

## Model Experience

间接产生，经由 `dsh-tool-spec-loop`：它注册 `spec_loop` 工具、其系统提示词段与其渲染报告；本包自身不注册任何提示词、schema 或结果。

#### KV Cache effect

独立 — 本包不发起任何模型请求。

## Known Limitations and Deferred Work

- **无遥测流提前终止** — 适配器结果只在运行完成时收集；引擎不消费增量残差/迭代遥测来提前终止发散中的运行（S-5/S-6）。适配器仍可返回带诊断的 `diverged` 来近似这一行为。
- **无 license 池上限强制** — license 时间累加进 `costs.licenseMs` 并报告；引擎不知道部署的池大小，因此从不因 license 原因停止运行。
- **无持久化每日预算** — 预算仅按次运行；跨运行的每日 Token/墙钟台账需要持久化 seam，尚未实现。
- **无检查点/恢复集成** — 热启动检查点（S-6）归适配器负责；引擎既不检查也不恢复它们。
