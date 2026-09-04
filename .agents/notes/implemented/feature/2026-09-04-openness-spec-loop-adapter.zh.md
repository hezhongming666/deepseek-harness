# Agent Note: Openness spec-loop 适配器 provider 与 HTTP JSON 桥

Status: implemented

[English](2026-09-04-openness-spec-loop-adapter.md) | 中文

## Problem

spec-loop 能力发布时只带了适配器 seam、没有 provider：[能力笔记](2026-09-02-spec-loop-capability.md) 记载，真正的 provider（CLI 启动/终止、遥测解析）因没有部署方拥有而属延期工作。随后一个部署方提出了需求——西门子 TIA Portal Openness，其 API 是仅 Windows 的进程内 .NET 库，Node 适配器只能通过宿主进程触达它。

## Decision

`@deepseek-ai/dsh-provider-openness` 随附第一个 spec-loop 适配器 provider。适配器把 `OpennessSpecLoopAdapter` 注册为 `ctx.specLoopAdapter`，并用一个小型 HTTP JSON 协议与 **Openness 桥**通信——桥是 Windows 宿主进程，保持一个 TIA Portal V21 工程打开，并实现随附动作（把候选参数写入绑定的全局数据块成员起始值、编译、上报 `{ compileErrors, compileWarnings, compileMs }`）。

- 协议共四条路由：`GET /health`（就绪 + 环境四元组）、`POST /validate`（廉价 S1 关卡）、`POST /run`（`success|diverged|infrastructure|killed` 加指标、许可证时长、环境）、`POST /cancel`（尽力而为——进行中的 Openness 调用无法抢占）。宿主不可用表现为 HTTP 503；run 串行执行（409）。
- 两种部署模式二选一：`url`（部署方自有的桥）或 `spawn`（适配器拥有本地桥进程，等待其 `{"event":"listening","url":…}` 就绪行，并随所属 fiber 杀掉它）。配置错误在加载时失败。
- 桥故障走 seam 自己的词汇：超时、中断与畸形响应以 `infrastructure`（S3）结束；被取消的 run 立即以 `killed` 结束并发尽力而为的 `/cancel`；`validate` 的传输失败以抛出方式让引擎归类 S3。
- 随附 C# 桥（`bridge/`）分两个构建档：默认档编译协议服务器与确定性的 `--fake` 宿主（无需 TIA，因此线协议层可被仓库 CI 验证），`-p:WithOpenness=true` 针对本机安装的 TIA Portal V21 API 编译真实 Openness 宿主。随附动作的参数域由部署方通过桥配置的 `{ block, member, min, max }` 全局数据块成员绑定定义。
- 示例覆盖层 `examples/openness-spec-loop/cordis.yml` 在随附 Web 组合之上挂载 provider 与 `spec_loop` 工具。

## Alternatives considered

- **适配器直接驱动 TIA Openness（经原生插件进程内 .NET）。** Openness 是仅 Windows 的 .NET Framework API，没有稳定的 Node 互操作路径；宿主进程能在候选运行之间保持 TIA 会话温热，并隔离耗许可的调用。未采用。
- **桥用 stdio（换行分隔 JSON）而非 HTTP。** HTTP 允许桥与 harness 分处不同 Windows 机器，符合部署形态（TIA 的许可与安装都在工程所在机），且适配器可针对进程内 HTTP 服务器测试而无需子进程。未采用。
- **只随附协议、不带 C# 桥。** 仓库将没有参考实现，也无法端到端冒烟协议；假宿主同时充当无 TIA 机器上的接线演示。未采用。
- **把 provider 放进 `packages/experimental/`。** 它是带测试与随附示例的完整能力 seam 角色，应与家族同处 `packages/spec-loop/`。未采用。

## Consequences

- 2026-09-02 笔记中“无随附 provider”的事实被部分取代：现在随附一个 provider；遥测流提前终止（S-5/S-6）仍属延期，桥只在 Openness 调用结束时上报结果。
- 真实 Openness 宿主只能在装有 TIA Portal V21 的机器上编译：仓库门禁验证协议层与假宿主，绑定 TIA 的宿主已针对安装的 V21 API 编译验证（TIA V21 把 Openness API 拆分为 `Siemens.Engineering.Base`/`.Step7` 程序集，软件对象由 `SoftwareContainer` 服务承载，编译经 `GetService<ICompilable>()`，全局数据块成员起始值只以动态 `StartValue` attribute 存在——变量属性面已消失；宿主已与 V21 对齐）。运行期程序集解析走官方 `Siemens.Collaboration.Net.TiaPortal.Openness.Resolver` 包（Copy Local 关闭），另以注册表派生的 PublicAPI 目录上的 `AssemblyResolve` 兜底非默认安装根。TIA Portal V21 真机持 STEP 7 Professional 试用许可的验证覆盖完整链路——解析器、`Siemens TIA Openness` 组校验、无头启动、目录型工程打开、工程/设备创建、硬件目录查询（`TypeIdentifier` 为 `OrderNumber:<订货号>/<版本>` 形式）、全局数据块成员起始值写入加真实编译上报 `compileErrors`/`compileWarnings`/`compileMs`，以及带真实模型生成的端到端 `spec_loop` 以 `satisfied` 收尾。
- 许可证记账保持近似：桥把编译墙钟时长上报为 `licenseMs`；没有许可证池台账。
- spawn 模式测试不启动子进程（仓库测试沙箱拒绝管道 stdio 的 spawn）；spawner 是注入 seam，就绪行与随 fiber 销毁的行为由假实现覆盖，外加 `apps/web/tests/openness-spec-loop.e2e.ts` 的一次组装 Web e2e 引导。
