# industrial/ — industrial-automation closed-loop capability family

English | [中文](README.zh.md)

The plugin realization of the industrial-automation closed-loop architecture ([design v1.1](../../design-proposals/industrial-automation-ai-agent-closed-loop-architecture.md)): deterministic verify-as-gate adjudication, mandatory human gates with A0–A3 automation levels, append-only traceability with three-level impact analysis, cold-start-gated knowledge libraries, and a DAG project orchestrator. The mapping from design sections to packages:

| Design mechanism | Package |
|---|---|
| §2.3 验证即门禁 / §7.2 deterministic verifiers | [`ia-verifier/`](ia-verifier/README.md) |
| §4.4/§6.1 traceability, impact analysis | [`ia-trace/`](ia-trace/README.md) |
| §5.1/§5.2 gates, automation levels | [`ia-gates/`](ia-gates/README.md) |
| §6.2/§4.3 knowledge libraries, learning sink | [`ia-knowledge/`](ia-knowledge/README.md) |
| §3.10/§4.1/§4.2 DAG orchestrator, inner loop, escalation | [`ia-orchestrator/`](ia-orchestrator/README.md) |
| §3 L3/L5 agent surface | [`tool-ia/`](tool-ia/README.md) |

| Package | Role | ctx key |
|---|---|---|
| [`ia-verifier/`](ia-verifier/README.md) | Deterministic verifier registry with built-in Structured Text syntax/lint and IO-symbol consistency validators | `ctx.iaVerifiers` |
| [`ia-verifier-openness/`](ia-verifier-openness/README.md) | Real-vendor compile channel: registers the `tia-compile` kind, which adjudicates TIA SCL through a TIA Portal compile over the Openness bridge | extends `ctx.iaVerifiers` |
| [`ia-trace/`](ia-trace/README.md) | Append-only traceability graph: nodes, typed links, change records, three-level impact analysis, requirement matrices | `ctx.iaTrace` |
| [`ia-gates/`](ia-gates/README.md) | Gate engine: six mandatory human gates, A0–A3 levels, always-human dangerous gates, approval-channel decisions | `ctx.iaGates` |
| [`ia-knowledge/`](ia-knowledge/README.md) | Standards/templates/cases libraries with mandatory citations, cold-start readiness, learning sink | `ctx.iaKnowledge` |
| [`ia-orchestrator/`](ia-orchestrator/README.md) | Conveyor-line DAG stage machine: verify-then-gate transitions, bounded inner-loop repair, escalation packages | `ctx.iaOrchestrator` |
| [`tool-ia/`](tool-ia/README.md) | Model-facing `ia_verify`/`ia_trace`/`ia_gate`/`ia_knowledge`/`ia_project` tools | registers on `ctx.tools` |

Compose order matters only through declared dependencies: `ia-orchestrator` requires `iaVerifiers` and `iaGates`, `tool-ia` requires all five services. The [`dsh-ia` bundle](../bundle/ia/README.md) and the [industrial-ia example](../../examples/industrial-ia/README.md) ship the complete composition.

The authority boundary is structural: no tool schema exposes a gate decide, a knowledge approve, or an escalation-resolution action — those stay human/rule channels inside the services.
