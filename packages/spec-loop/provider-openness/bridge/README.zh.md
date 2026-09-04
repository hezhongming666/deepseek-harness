# OpennessBridge — TIA Portal Openness HTTP JSON 桥

[English](README.md) | 中文

`@deepseek-ai/dsh-provider-openness` 背后的桥进程：一个 Windows 宿主，保持一个 TIA Portal V21 工程打开，并在 127.0.0.1 上服务[适配器的 HTTP JSON 协议](../README.md#the-wire-protocol)。适配器可以连接一个已运行的桥（`url` 模式），也可以在 `spawn` 模式下拥有一个。

## 功能

- `GET /health`——就绪状态与环境四元组（`softwareVersion`、`osKernel`）。
- `POST /validate`——廉价的 S1 关卡：按配置检查参数键与闭区间数值边界；不编译、不写工程。
- `POST /run`——随附动作。`action: compile`（默认）把每个参数写入其绑定的全局数据块成员的起始值，编译 PLC，上报 `{ compileErrors, compileWarnings, compileMs }`。`action: online` 写入相同的起始值，把软件下载到仿真目标、上线，上报 `{ downloadState, downloadMessages, onlineValues, readMs, downloadMs }`。测量的墙钟时长同时作为 `licenseMs`（桥能测量的耗许可跨度）上报。
- `POST /cancel`——尽力而为：进行中的 Openness 调用无法被抢占，桥在被取消的 run 结束时丢弃其结果。

run 串行执行（在飞时返回 HTTP 409）；宿主不可用表现为 HTTP 503，适配器将其归类为 S3。

## 真实宿主的前置条件

- 运行桥的 Windows 用户必须是本地组 **`Siemens TIA Openness`** 的成员（`net localgroup "Siemens TIA Openness" <用户> /add`）。组关系只有通过新登录才能进入进程令牌：加组后请注销重新登录，再启动桥。
- 桥在运行期通过官方 `Siemens.Collaboration.Net.TiaPortal.Openness.Resolver` 包从已安装的 TIA Portal 解析 `Siemens.Engineering.*`；Openness 程序集保持 Copy Local 关闭（TIA 自身的加载器拒绝本地副本）。
- 需安装 TIA Portal V21 及其 Openness 组件。创建设备与编译需要许可证池里的 **STEP 7 Basic/Professional 许可证**（TIA Portal 试用许可证同样满足）；否则 `CreateWithItem` 与编译会以 `LicenseNotFoundException` 失败。
- run 动作的工程需要 PLC 设备：配置 `bootstrap` 自动创建，或把 `projectPath` 指向一个已含 PLC 设备的既有工程。
- `online` 动作把软件下载到仿真 CPU 并读回在线值，因此需要安装 S7-PLCSIM（V21）并提供经典 `PLCSIM` 接口；不需要实体 PLC。

## 构建

TIA Portal Openness 是仅 Windows 的进程内 .NET API。桥有两个构建档：

```sh
# Protocol layer + deterministic fake host — no TIA Portal needed. This is
# what the repo gates can build anywhere.
dotnet build OpennessBridge.csproj -c Release

# Full build against the installed TIA Portal V21 Openness API. TIA V21 ships
# the API as split per-domain assemblies under the net48 folder.
dotnet build OpennessBridge.csproj -c Release -p:WithOpenness=true ^
  -p:OpennessApiDir="C:\Program Files\Siemens\Automation\Portal V21\PublicAPI\V21\net48"
```

默认 `OpennessApiDir` 与 V21 标准安装布局一致；按机器调整即可。Openness 宿主（`OpennessHost.cs`）只在完整构建中编译；其 API 用法已针对真实 V21 参考程序集编译通过，运行期的写入、编译、下载与在线读取路径在部署机上用工程副本冒烟验证。

## 运行

```sh
OpennessBridge.exe --config bridge.example.json          # real host, needs TIA + a project
OpennessBridge.exe --fake --config bridge.example.json   # deterministic fake, any Windows machine
OpennessBridge.exe --config bridge.json --list-devices   # print device items (pick the `device` value)
OpennessBridge.exe --config bridge.json --list-tags      # print PLC tags (write the `params` map)
OpennessBridge.exe --config bridge.json --find-device "1214C"  # catalog lookup (type identifiers)
```

启动时桥在 stdout 打印恰好一行——`{"event":"listening","url":"http://127.0.0.1:<port>"}`——适配器的 spawn 模式等待这一行。配置字段：`port`（0 表示自动发现空闲端口）、`projectPath`、`mode`（`WithoutUserInterface` | `WithUserInterface`）、`device`（空表示选择第一个带 PLC 软件的设备）、`action`（`compile` | `online`，默认 `compile`）、`simulation`（`modeName`、`interfaceName`、`interfaceNumber`、`targetInterface`——`online` 动作使用的 S7-PLCSIM 目标；`targetInterface` 为空表示选择第一个可用项）、`params`（参数键 → `{ block, member, min, max }` 全局 DB 成员绑定），以及可选 `bootstrap` 块（`directory`、`projectName`、`deviceOrderNumber`、`deviceName`、`deviceVersion`）——当 `projectPath` 不存在时自动创建目录型工程并插入 PLC 设备。Openness 程序需要配套安装的 TIA Portal 与 run 动作所执行工程操作的许可证。

## 随附动作

参数域由部署方通过配置的 `params` 映射定义：每个参数键绑定一个全局数据块成员，run 把候选的数值写入这些成员的起始值（V21 的动态 `StartValue` 属性）。

- `action: compile`（默认）——编译 PLC 并上报错误/警告数量。该动作的演示 spec 断言 `compileErrors lte 0` 并最小化 `compileErrors`。
- `action: online`——把软件下载到 S7-PLCSIM 目标、上线，并通过 V21 的动态 `OnlineValue` 属性读回每个绑定成员的当前值。它上报 `{ downloadState, downloadMessages, onlineValues, readMs, downloadMs }`，把下载/在线读取失败映射为带清晰 `error` 的 `diverged` 状态。V21 没有 `SetInterfaceToPlcsim()` 辅助方法：目标通过连接配置的 `PLCSIM` PC 接口（默认编号 1）解析，如 Openness 手册所述；`simulation` 覆盖这些名称。下载回调处理标准的停止 / 一致性 / 全块 / 目标 / 重初始化与启动模块选择，并对任何未处理的配置失败关闭。

需要不同动作（工艺对象扫描、导出设置）的部署方扩展 C# 宿主；适配器与协议保持不变。
