# @deepseek-ai/dsh-ia-knowledge

[English](README.md) | 中文

标准/模板/案例知识库（§6.2）与学习沉淀（§4.3）。每条条目带强制来源与版本引用；检索是确定性关键词匹配且结果有界，因此命中可复现、可归因。学习沉淀的条目以 `pending-review` 入库，等待人工批准——这正是架构要求的质量门控。

## 配置

| 键 | 含义 |
|---|---|
| `minTemplates` | 冷启动最小模板规模，默认 20（§6.2）。 |
| `minCases` | 冷启动最小案例规模，默认 30（§6.2）。 |
| `maxSearchResults` | 检索结果上限，默认 10。 |

非正整数在加载时失败。

## Service API

`ctx.iaKnowledge`：

- `record({ library, title, content, tags?, source, version, recordedBy, reviewStatus })` — 记录一条条目；同库内重复 title+content 抛 `DuplicateKnowledgeEntryError`，缺失引用抛 `MissingCitationError`。
- `approveEntry(id)` — 人工批准路径；条目只批准一次。
- `entriesList(library)` — 某库的全部条目。
- `libraries()` — 三种封闭库类型，按规范顺序。
- `search(library, query)` — 每个空白分隔词都必须命中；命中按匹配数排序、封顶，并始终携带引用。
- `readiness()` — 冷启动快照：各库计数与低于配置最小值的缺口。

当库低于最小规模时，检索结果标记 `degraded: true`——架构中显式的纯生成模式标志（§6.2）。invariant 伴随插件在每次变更后证明引用契约。

## Model Experience

间接地，通过 dsh-tool-ia 的 `ia_knowledge` 工具——这是渲染这些库的唯一面向模型界面。

#### KV Cache effect

独立。库不持有请求作用域状态，不注册提示词或工具 schema；条目文本只作为 `ia_knowledge` 工具结果进入请求。

## Known Limitations and Deferred Work

- **内存库** — 条目随服务生命周期存续；基于文件或 storage-domain、带人工可编辑种子文件的库已延后。
- **关键词检索而非向量** — 确定性子串匹配是诚实的冷启动 RAG；语义检索延后到向量后端。
- **批准仅限服务** — `approveEntry` 是供未来人工命令/UI 使用的服务 API；任何面向模型工具都不暴露它。
