# OpennessBridge — TIA Portal Openness HTTP JSON 桥

[English](README.md) | 中文

`@deepseek-ai/dsh-provider-openness` 背后的桥进程：一个 Windows 宿主，保持一个 TIA Portal V21 工程打开，并在 127.0.0.1 上服务[适配器的 HTTP JSON 协议](../README.md#the-wire-protocol)。适配器可以连接一个已运行的桥（`url` 模式），也可以在 `spawn` 模式下拥有一个。

## 功能

- `GET /health`——就绪状态与环境四元组（`softwareVersion`、`osKernel`）。
- `POST /validate`——廉价的 S1 关卡：按配置检查参数键与闭区间数值边界；不编译、不写工程。
- `POST /run`——随附动作。`action: compile`（默认）把每个参数写入其绑定的全局数据块成员的起始值，编译 PLC，上报 `{ compileErrors, compileWarnings, compileMessages, compileMs }`。`action: online` 写入相同的起始值，把软件下载到仿真目标、上线，上报 `{ downloadState, downloadMessages, onlineValues, readMs, downloadMs }`。`action: generate` 渲染配置里的 SCL 模板（把每个 `{{param}}` 占位符替换为候选的数值）、导入/替换命名块、编译，并上报编译字段加 `blockName`。`action: import` 渲染配置里的 Openness XML 模板（同样的 `{{param}}` 占位符规则）、导入目标组合、编译，并上报编译字段加 `importedTarget`。`action: export` 把目标类型的第一个工程对象导出到 XML 文件并上报 `{ exportPath, exportMs }`。测量的墙钟时长同时作为 `licenseMs`（桥能测量的耗许可跨度）上报。
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

默认 `OpennessApiDir` 与 V21 标准安装布局一致；按机器调整即可。Openness 宿主（`OpennessHost.cs`）只在完整构建中编译；其 API 用法已针对真实 V21 参考程序集编译通过，运行期的写入、编译、下载、在线读取与块生成路径在部署机上用工程副本冒烟验证。

## 运行

```sh
OpennessBridge.exe --config bridge.example.json          # real host, needs TIA + a project
OpennessBridge.exe --fake --config bridge.example.json   # deterministic fake, any Windows machine
OpennessBridge.exe --config bridge.json --list-devices   # print device items (pick the `device` value)
OpennessBridge.exe --config bridge.json --list-tags      # print PLC tags (write the `params` map)
OpennessBridge.exe --config bridge.json --find-device "1214C"  # catalog lookup (type identifiers)
```

启动时桥在 stdout 打印恰好一行——`{"event":"listening","url":"http://127.0.0.1:<port>"}`——适配器的 spawn 模式等待这一行。配置字段：`port`（0 表示自动发现空闲端口）、`projectPath`、`mode`（`WithoutUserInterface` | `WithUserInterface`）、`device`（空表示选择第一个带 PLC 软件的设备）、`action`（`compile` | `online` | `generate` | `import` | `export`，默认 `compile`）、`simulation`（`modeName`、`interfaceName`、`interfaceNumber`、`targetInterface`——`online` 动作使用的 S7-PLCSIM 目标；`targetInterface` 为空表示选择第一个可用项）、`generate`（`blockName`、`source`——`generate` 动作使用的 SCL 模板）、`import`（`target`——`software` | `blocks` | `tagTables`，`source`——Openness XML）、`export`（`target`、`directory`）、`params`（参数键 → `{ block, member, min, max }` 全局 DB 成员绑定；`generate`/`import`/`export` 动作只使用 `min`/`max`），以及可选 `bootstrap` 块（`directory`、`projectName`、`deviceOrderNumber`、`deviceName`、`deviceVersion`）——当 `projectPath` 不存在时自动创建目录型工程并插入 PLC 设备。Openness 程序需要配套安装的 TIA Portal 与 run 动作所执行工程操作的许可证。

## 随附动作

参数域由部署方通过配置的 `params` 映射定义：每个参数键绑定一个全局数据块成员，run 把候选的数值写入这些成员的起始值（V21 的动态 `StartValue` 属性）。

- `action: compile`（默认）——编译 PLC 并上报错误/警告数量。该动作的演示 spec 断言 `compileErrors lte 0` 并最小化 `compileErrors`。
- `action: online`——把软件下载到 S7-PLCSIM 目标、上线，并通过 V21 的动态 `OnlineValue` 属性读回每个绑定成员的当前值。它上报 `{ downloadState, downloadMessages, onlineValues, readMs, downloadMs }`，把下载/在线读取失败映射为带清晰 `error` 的 `diverged` 状态。V21 没有 `SetInterfaceToPlcsim()` 辅助方法：目标通过连接配置的 `PLCSIM` PC 接口（默认编号 1）解析，如 Openness 手册所述；`simulation` 覆盖这些名称。下载回调处理标准的停止 / 一致性 / 全块 / 目标 / 重初始化与启动模块选择，并对任何未处理的配置失败关闭。
- `action: generate`——渲染 `generate.source`（SCL 文本，其中的 `{{param}}` 占位符被替换为该参数的数值候选值，不变文化格式），导入/替换命名块，然后编译并上报编译字段加 `blockName`。模板走 V21 的外部源路线（`ExternalSourceGroup.ExternalSources.CreateFromFile` 再 `GenerateBlocksFromSource`），接受纯 SCL 文本、无需 Openness XML 包装，并覆盖同名既有块；渲染后的文本写入按 run 命名的临时文件并在导入后删除。未知占位符与导入/编译失败映射为 `diverged`。该动作的 `params` 映射只提供数值 `min`/`max` 域（无需 `block`/`member`）。
- `action: import`——渲染 `import.source`（Openness 格式 XML，其中的 `{{param}}` 占位符被替换为该参数的数值候选值），导入目标组合，然后编译并上报编译字段加 `importedTarget`。V21 没有 `ImportProvider`：导入是组合级的 `Import(FileInfo, ImportOptions)` 方法——`blocks` 对应 `BlockGroup.Blocks`、`tagTables` 对应 `TagTableGroup.TagTables`——使用 `ImportOptions.Override`（覆盖既有）。`software` 目标在 V21 中没有导入方法，会以清晰的 infrastructure 错误失败。未知占位符与导入/编译失败映射为 `diverged`。该动作的 `params` 映射只提供 `min`/`max`。
- `action: export`——把目标类型的第一个工程对象导出到 `<directory>\openness-export-<target>-<runId>.xml` 并上报 `{ exportPath, exportMs }`。V21 没有 `ExportProvider`，且按对象导出（`PlcBlock.Export` / `PlcTagTable.Export`，使用 `ExportOptions.WithDefaults`），因此组目标导出其第一个对象；`software` 目标在 V21 中没有导出方法。目录不存在时会被创建；导出失败映射为 `diverged`。这是 `import` 动作的实用往返配套工具，不是数值搜索目标。

### V21 导入 XML 格式（示例）

`import` 动作消费 Openness 的 `<Document>` 导出格式；运行一次 `action: export` 即可获得工程的确切格式。一个含单个 `Int` 标签的最小标签表（V21 格式——属性拼写以实际导出为准，请通过导出确认）：

```xml
<?xml version="1.0" encoding="utf-8"?>
<Document>
  <SW.Tags.PlcTagTable ID="0">
    <AttributeList>
      <Name>Diag</Name>
    </AttributeList>
    <ObjectList>
      <SW.Tags.PlcTag ID="1">
        <AttributeList>
          <Name>counter</Name>
          <DataTypeName>Int</DataTypeName>
          <LogicalAddress>%MW0</LogicalAddress>
          <Comment><MultiLanguageText Lang="en-US">cycle counter</MultiLanguageText></Comment>
        </AttributeList>
      </SW.Tags.PlcTag>
    </ObjectList>
  </SW.Tags.PlcTagTable>
</Document>
```

块与 DB 使用相同的 `<Document>` 包装（`<SW.Tags.PlcTagTable>` 换成 `<SW.Blocks.GlobalDB>`）。`import.source` 的占位符遵循同样的 `{{param}}` 规则，因此 XML 中的 `{{threshold}}` 会被替换为候选的数值。

需要不同动作（工艺对象扫描、导出设置）的部署方扩展 C# 宿主；适配器与协议保持不变。
