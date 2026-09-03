# @deepseek-ai/dsh-tool-spec-loop

[English](README.md) | 中文

面向模型的 `spec_loop` 工具，架设在 [`dsh-spec-loop`](../spec-loop/README.md) 引擎与适配器 seam 之上。一次调用跑完整条确定性参数搜索闭环：多模型生成回退、包络与校验门控、单调修复、失败分级与成本封顶。引擎负责闭环记账；本包负责生成、部署上限与模型可见面。

## 配置

全部字段位于 `tool-spec-loop` 条目的 `config` 之下；`models` 必填。

| 字段 | 默认 | 含义 |
| :--- | :--- | :--- |
| `models` | —（必填） | 候选参数生成的有序 `{ provider, model }` 回退链；靠后的条目只有在前序全部失败后才运行 |
| `maxIterations` | 256 | 单次运行迭代数的部署上限 |
| `maxWallClockMs` | 3_600_000 | 单次运行墙钟预算的部署上限 |
| `maxTokens` | 200_000 | 单次运行计费生成 Token 的部署上限 |
| `maxGenerationTokens` | 4096 | 单次生成调用的输出上限 |
| `maxHistoryRecords` | 16 | 嵌入下一次生成提示词的先前迭代记录数 |
| `maxParamsChars` | 2048 | 单条嵌入记录 params 的序列化字符上限 |
| `maxResultChars` | 16_384 | 渲染报告的字符上限 |

超出部署上限的 spec 预算会在任何工作开始前以 `INVALID_SPEC` 失败。工具通过 `ctx.get('specLoopAdapter')` 解析适配器，未挂载提供方时调用失败。它不要求调用方 agent；调用方 agent 的会话 id 会转发给生成请求，用于回放路由。

## Model Experience

### 系统提示词段

#### 模型看到什么

一份固定的使用策略段，每次组合注册一次，文本逐字如下：

##### 逐字使用策略段

```markdown
Use the spec_loop tool only for iterative parameter search against a spec contract evaluated by a mounted spec-loop adapter. One call runs the whole deterministic loop: multi-model generation, validation, monotonic repair, and cost caps are enforced inside the tool. You select the spec and act on the returned report; prefer it over repeated manual trial when numeric assertions exist.
```

#### Token effect

固定 — 该段在组合的每份系统提示词中组装一次；它不含任何随数据变化的内容。

#### KV Cache effect

仅追加且前缀稳定 — 该段文本在运行时从不改变，因此不会使已可复用的提示词前缀失效。

### spec_loop 工具 schema

#### 模型看到什么

生成的 [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-spec-loop) 中的 `spec_loop` 工具 schema 与描述。那里未列出的差异：`spec` 以一个 JSON 值承载整个契约（`objective`、`assertions`、`budgets`、`repair`、可选 `envelope` 与 `description`）；`initialParams` 可选指定一个在任何生成之前评估的起始候选参数；结果是完整运行报告（逐迭代 S0–S3 判定、最优已接受参数、成本汇总），渲染为有界文本摘要。

#### Token effect

有条件 — schema 文本是每次组合的固定成本；每次调用还额外支付受 `maxResultChars` 限制的渲染报告。

#### KV Cache effect

仅追加 — schema 构成固定的稳定前缀；它不会使已可复用的提示词前缀失效。

### 生成请求

#### 模型看到什么

每个候选提案都是一次独立的模型请求，由 spec、当前迭代编号与有界历史构建。system 槽位是以下逐字文本；user 槽位随数据变化（spec 描述、目标、断言、包络、修复裕量、逐条按 `maxParamsChars` 截断的先前记录）。

##### 逐字生成 system 文本

```markdown
You propose parameter sets for a deterministic spec loop over engineering software. Respond with exactly one JSON object whose keys are the parameter names and whose values are numbers, booleans, strings, or nested objects — no prose, no markdown, no explanation.
```

#### Token effect

封顶 — 每次调用限 `maxGenerationTokens` 输出，每次运行最多 `maxIterations` 次调用，一次运行的计费 Token 总量受 spec `budgets.maxTokens` 与 `maxTokens` 上限共同收紧。

#### KV Cache effect

独立 — 生成请求是独立的模型会话；它们从不共享或替换调用会话的提示词前缀。

## Known Limitations and Deferred Work

- **无具名 spec 注册表** — spec 契约在每次调用内联传入；带版本修订的持久注册表尚未实现。
- **无运行中审批** — 包络违规归类为 S1 且从不进入软件，但把逼近包络的提案升级给人类审批是壳层策略，本工具不实现。
- **无回放模式** — 引擎以组合方式回放（脚本化生成器回喂已记录提案），但本工具没有面向已记录运行的执行器。
- **有界生成历史** — 提示词只嵌入最近 `maxHistoryRecords` 条记录，因此超长运行最早期的上下文不会进入后续生成。
- **无持久化每日预算** — 成本封顶仅按次运行；跨运行的每日台账需要持久化 seam。
