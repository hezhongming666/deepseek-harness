# spec-loop/ — 确定性 spec-loop 能力族

[English](README.md) | 中文

本族在软件适配器之上运行有界、可回放的参数搜索闭环——spec 契约、数值断言、S0–S3 失败分级、带 ε 裕量的单调修复，以及迭代数/墙钟/Token 三重封顶——并把该闭环以工具形式暴露给模型。

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`spec-loop/`](spec-loop/README.md) | 定义闭环引擎、spec 校验与软件适配器 seam | `ctx.specLoopAdapter` |
| [`tool-spec-loop/`](tool-spec-loop/README.md) | 以多模型回退生成把确定性闭环暴露给模型 | 注册于 `ctx.tools` |

引擎在运行之间不保留状态：全部记账都是生成与适配器结果序列的纯函数，因此回放就是让生成器回放已记录提案的一次运行。
