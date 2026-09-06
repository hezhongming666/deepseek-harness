# 工业自动化闭环

[English](README.md) | 中文

可选 Web 覆盖层，在出厂组合之上挂载[工业能力族](../../packages/industrial/README.md)，让 Agent 以"验证即门禁"的纪律运行工程闭环：`ia_verify` 用确定性验证器裁决每一件产物，`ia_project` 驱动输送线 DAG，`ia_trace` 维护需求矩阵与三级影响分析，`ia_gate` 请求六道强制人工闸门，`ia_knowledge` 带出处检索标准/模板/案例库。

## 运行

```sh
dsh web --patch examples/industrial-ia/cordis.yml
```

拥有 TIA Portal Openness 桥的现场在此基础上追加真实厂商编译通道（先编辑覆盖层里的 `url`）：

```sh
dsh web --patch examples/industrial-ia/cordis.yml --patch examples/industrial-ia/cordis.openness.yml
```

同一组行也以 [`dsh-ia` bundle](../../packages/bundle/ia/README.md) 形式发布，供偏好 bundle 组合的 profile 使用。要持久挂载，把 `@deepseek-ai/dsh-ia` 列入 profile 的 `dsh.profile.bundles`，并让 bundle 能从 profile 的 node_modules 解析（例如 junction 指向 checkout）。工业状态（项目、追溯图、闸门裁决、知识条目）只有在每个有状态服务配置了 `dataDir` 后才跨重启存续——用 config 覆盖修补 `ia-gates` / `ia-trace` / `ia-knowledge` / `ia-orchestrator` 行，例如 `dataDir: D:\Tools\tia-smoke\ia-data\gates`。

## 冒烟

挂载覆盖层或 bundle 后，无需模型调用即可端到端验证闭环：

```sh
pnpm exec tsx examples/industrial-ia/smoke.mjs
```

冒烟脚本用真实 Loader 装配六行配置，检查工具注册、验证通过与失败各一例、强制闸门清单、输送线模板，以及仅限请求的闸门 schema。第二次装配在本地假桥之上挂载 openness 编译验证器，证明厂商通道：`tia-compile` 完成注册、经桥线缆协议裁决 TIA SCL，并加入输送线控制程序验证器名单。第三次装配证明持久化：一次启动写入的项目、闸门裁决、知识条目与追溯图，在针对同一组 `dataDir` 的全新启动后原样恢复。

## 试用

让 Agent 校验一段结构化文本程序：

```
Run ia_verify with kind st-syntax on this program:
PROGRAM Conveyor
VAR
  Start : BOOL;
  Count : INT := 0;
END_VAR
IF Start THEN
  Count := Count + 1;
END_IF
END_PROGRAM
```

随后驱动完整阶段链：`ia_project init`，提交需求产物，请人工批准挂起的 `requirement-baseline` 闸门，再逐阶段推进。控制程序阶段拒绝未通过 `st-syntax`/`st-lint` 的产物——挂载 openness 覆盖层后还有 `tia-compile`——在三次提交的内环预算内重试，预算耗尽后生成升级包上报。`ia_trace matrix` 显示哪些需求仍缺少实现与测试。挂载 `tia-compile` 时提交两份方言：`text` 携带供本地检查的 harness `PROGRAM` 源码，`vendorSource` 携带供真实编译的 TIA SCL 块（`FUNCTION`/`FUNCTION_BLOCK`，块名与配置的 `blockName` 一致）。

本覆盖层行组合的无密钥 Loader 装配由 [tool-ia loader 测试](../../packages/industrial/tool-ia/tests/loader-composition.spec.ts) 证明；无需任何外部工程软件——确定性验证器全部本地运行。
