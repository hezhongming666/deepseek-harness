# spec-loop/ — deterministic spec-loop capability family

English | [中文](README.zh.md)

This family runs bounded, replayable parameter-search loops — spec contract, numeric assertions, S0–S3 failure classification, monotonic repair with an epsilon margin, and iteration/wall-clock/token caps — over software adapters, and exposes the loop to the model as a tool.

| Package | Role | ctx key |
|---|---|---|
| [`spec-loop/`](spec-loop/README.md) | Defines the loop engine, spec validation, and the software adapter seam | `ctx.specLoopAdapter` |
| [`tool-spec-loop/`](tool-spec-loop/README.md) | Exposes the deterministic loop to the model with multi-model generation fallback | registers on `ctx.tools` |

The engine holds no state between runs: all bookkeeping is a pure function of the generation and adapter outcome sequence, so a replay is a run whose generator feeds logged proposals back.
