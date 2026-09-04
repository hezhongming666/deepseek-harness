# @deepseek-ai/dsh-provider-openness

[English](README.md) | 中文

**西门子 TIA Portal Openness 的 spec-loop 适配器 provider**。它在 `ctx.specLoopAdapter` 上注册一个 `OpennessSpecLoopAdapter`，让 `spec_loop` 工具通过 Openness 桥对 TIA Portal V21 工程运行有界参数搜索闭环。本包提供适配器、线协议与 spawn 模式的桥进程生命周期；随包的 [C# 桥](bridge/README.md) 是部署方的 Openness 宿主。

| 组成 | 角色 |
|---|---|
| `OpennessSpecLoopAdapter` | `specLoopAdapter` provider：经 HTTP JSON 实现 `validate`（S1 关卡）与 `run`（带取消的执行） |
| [bridge/](bridge/README.md) | Windows 宿主进程：保持一个 TIA Portal V21 工程打开、在 127.0.0.1 上服务协议，并实现随附的编译动作（另含确定性的 `--fake` 模式） |
| `src/wire.ts` | 对桥的每个响应做敌意输入校验（桥是外部进程） |

## 线协议

桥使用纯 HTTP JSON。`GET /health` 报告就绪状态与环境四元组；`POST /validate` 接收 `{ params }` 并返回 `{ ok, reasons }`；`POST /run` 接收 `{ runId, params }` 并返回 `{ runId, status: success|diverged|infrastructure|killed, result?, licenseMs?, error?, environment? }`；`POST /cancel` 接收 `{ runId }` 且尽力而为——进行中的 Openness 调用无法被抢占。宿主不可用表现为 HTTP 503；已有 run 在飞时下一个 run 得到 409。

随附动作的参数域由部署方定义：桥配置把每个参数键映射到一个全局数据块成员（`{ block, member, min, max }`），run 把候选的数值写入这些成员的起始值（V21 的动态 `StartValue` 属性）并编译 PLC，结果携带 `{ compileErrors, compileWarnings, compileMs }`，编译墙钟时长同时作为 `licenseMs` 上报。

## 配置

所有字段位于 `provider-openness` 条目的 `config` 之下；`url` 与 `spawn.command` 二选一，必填其一。

```ts
import type { Config } from '@deepseek-ai/dsh-provider-openness'
// {
//   url: string,              // base URL of a running bridge
//   spawn: {                  // the adapter owns a local bridge process
//     command: string,        // e.g. 'dotnet'
//     args: string[],         // e.g. ['OpennessBridge.dll']
//     cwd: string,
//     port: number,           // 0 = the bridge picks one and reports it
//     readyTimeoutMs: number,
//   },
//   requestTimeoutMs: number, // per-request cap; overruns report infrastructure
// }
```

配置错误（两模式都缺或都有、非 http URL、越界上限）在加载时失败。spawn 模式下适配器首次使用时启动桥、等待其 `{"event":"listening","url":…}` 就绪行，并随所属 fiber 杀掉子进程。桥中断、超时与畸形响应表现为 `infrastructure` 结果（S3）；被取消的 run 立即以 `killed` 结束并发出尽力而为的 `/cancel`；`validate` 的传输失败以抛出方式让引擎归类为 S3。

## Model Experience

间接生效，经由 `dsh-tool-spec-loop` 渲染每次运行的报告；适配器只提供从桥收到的逐迭代结果。

#### KV Cache effect

无直接失效；由具名消费者负责请求前缀的变更。

## Known Limitations and Deferred Work

- **无遥测流提前终止**——桥只在 Openness 调用结束时上报结果；发散从最终编译结果判定，而非增量求解器遥测。
- **真实 Openness 宿主编译已验证、运行期由部署方验证**——仓库构建可在任何机器上编译协议层与假宿主，绑定 TIA 的宿主已在 TIA 机器上针对安装的 V21 API 编译通过（V21 的变量/编译面已在仓库内对齐）；其运行期写入与编译路径在部署时用工程副本冒烟验证（见[桥 README](bridge/README.md)）。
- **取消无法抢占 Openness**——`/cancel` 在进行中的调用结束后丢弃其结果；截至彼时的许可证时长仍被消耗。
- **许可证记账为编译墙钟时长**——桥把编译的墙钟跨度上报为 `licenseMs`；真正的许可证池台账仍属部署方。
