# @deepseek-ai/dsh-ia

[English](README.md) | 中文

工业自动化闭环的可安装 profile 组合包：一个 patch 层插入确定性验证器注册表、闸门引擎（A1）、追溯图、知识库、输送线编排器与面向模型工具界面。包的实体是 `cordis.patch.yml`，通过 `dsh.bundle.patch` manifest 字段声明。

## 使用

在 profile 的组合包列表中声明本包，或以覆盖层方式应用同一组行：

```sh
dsh web --patch examples/industrial-ia/cordis.yml
```

## 行

| id | 包 |
|---|---|
| `ia-verifier` | `@deepseek-ai/dsh-ia-verifier` |
| `ia-gates` | `@deepseek-ai/dsh-ia-gates`（等级 `A1`） |
| `ia-trace` | `@deepseek-ai/dsh-ia-trace` |
| `ia-knowledge` | `@deepseek-ai/dsh-ia-knowledge`（最小值 20/30，上限 10） |
| `ia-orchestrator` | `@deepseek-ai/dsh-ia-orchestrator` |
| `tool-ia` | `@deepseek-ai/dsh-tool-ia` |

部署通过修补 `ia-gates` 行把自动化等级提升到 `A2` 并注册自动放行规则；恒人工闸门永不随等级变化。真实厂商编译验证器 `@deepseek-ai/dsh-ia-verifier-openness` 刻意不进 bundle：其桥 `url` 由部署方持有且为必填，因此拥有 TIA Portal Openness 桥的现场经 profile patch 或 `examples/industrial-ia/cordis.openness.yml` 覆盖层挂载它。

## Model Experience

间接地，通过 dsh-tool-ia——它拥有本组合包挂载的所有面向模型界面。

#### KV Cache effect

独立。组合包是静态 patch 载体；挂载的各包拥有其 README 中所记录的 KV 缓存行为。

## Known Limitations and Deferred Work

- **仅 patch 载体** — 组合包不附带自身运行时粘合；一切行为都在挂载的包中。
- **默认 A1** — 提升等级是部署编辑，绝不隐式发生；A2 规则注册仍是服务 API 调用。
