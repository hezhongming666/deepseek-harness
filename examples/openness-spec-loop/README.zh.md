# Openness spec-loop

[English](README.md) | 中文

可选 Web 覆盖层：挂载 [TIA Portal Openness spec-loop 适配器](../../packages/spec-loop/provider-openness/README.md) 与面向模型的 `spec_loop` 工具，让 agent 通过 Openness 桥对 TIA Portal V21 工程运行有界参数搜索闭环。

## 前置条件

- 一台装有 TIA Portal V21 与 Openness API 的 Windows 主机，以及一个 TIA 可打开的工程。按[桥 README](../../packages/spec-loop/provider-openness/bridge/README.md) 构建并启动桥（只想验证接线时可用 `--fake`，无需 TIA）。
- 桥可从 `OPENNESS_BRIDGE_URL` 访问（默认 `http://127.0.0.1:4279`）。

## 运行

```sh
OPENNESS_BRIDGE_URL=http://127.0.0.1:4279 dsh web --patch examples/openness-spec-loop/cordis.yml
```

## 试一下

让 agent 用桥的随附动作执行一次 `spec_loop` 调用——候选参数写入 PLC 变量起始值，桥执行编译，闭环最小化编译错误数。对应示例配置里的 `coolingTimeMs`/`threshold` 绑定：

```json
{
  "id": "compile-clean",
  "objective": { "path": "compileErrors", "direction": "minimize" },
  "assertions": [{ "id": "errors", "path": "compileErrors", "predicate": "lte", "target": 0 }],
  "budgets": { "maxIterations": 8 },
  "repair": { "margin": 1, "maxNoImprovement": 3 },
  "envelope": { "bounds": { "coolingTimeMs": { "min": 0, "max": 60000 }, "threshold": { "min": 0, "max": 100 } } },
  "description": "coolingTimeMs and threshold are PLC tag start values set before the compile."
}
```

一次调用跑完整条确定性闭环并返回审计报告；模型只提供 spec 与可选的起始候选。桥不可达时每个候选都会得到基础设施（S3）判定，因此即使 TIA 尚未就绪，接线本身也是可观测的。
