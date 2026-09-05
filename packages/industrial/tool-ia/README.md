# @deepseek-ai/dsh-tool-ia

English | [中文](README.zh.md)

The model-facing surface of the industrial closed loop: five tools over the verifier, trace, gate, knowledge, and orchestrator services. The authority boundary is structural — no schema exposes a gate decide, a knowledge approve, or an escalation-resolution action.

## Configuration

| key | meaning |
|---|---|
| `enabled` | Which tools to register; default all five. Omitted names stay unregistered. |

## Tools

| Tool | Surface |
|---|---|
| `ia_verify(kind, source, vendorSource?, fileName?)` | Runs one deterministic verifier and returns the pass/fail report with diagnostics and evidence. External compile kinds (e.g. `tia-compile`) read `vendorSource` and fall back to `source`. |
| `ia_trace(action, …)` | `record` / `link` / `change` / `impact` / `matrix` over the append-only trace graph. |
| `ia_gate(action, …)` | `list` / `request` — requests only; pending requests round-trip the approval channel. |
| `ia_knowledge(action, …)` | `search` / `record` / `readiness`; records enter `pending-review`. |
| `ia_project(action, …)` | `init` / `list` / `status` / `advance` / `submit` over the orchestrator DAG. |

Trace and project operations scope to the calling agent: trace per agent session, project per agent with explicit `projectId` overrides. The invariant companion proves the registered `ia_gate` schema never exposes a decision action.

## Model Experience

### ia_verify tool

#### What the model sees

The generated [`ia_verify` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-ia): the `kind` enum mirrors the registered validator kinds. Results are the complete report — `pass`, positioned `diagnostics`, and `evidence` — nothing is summarized away.

#### Token effect

Schema cost is fixed per request where the tool is visible; result size scales with the artifact's diagnostic count, bounded by the source the model submitted.

#### KV Cache effect

Prefix-stable while the definition, visibility, and registered `kind` enum are unchanged. Registering an additional verifier kind changes the enum and may invalidate reuse from this schema.

### ia_trace tool

#### What the model sees

The generated [`ia_trace` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-ia) with the five actions. Results return service-issued node ids (`node-<n>`), the three-level impact digest, and matrix rows with coverage verdicts; a non-agent caller is rejected because the graph needs an owning session scope.

#### Token effect

Schema cost is fixed; result size grows with the returned node/matrix row count, capped only by what the project recorded.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. New node/link kinds would change the enum and may invalidate reuse.

### ia_gate tool

#### What the model sees

The generated [`ia_gate` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-ia) with `list`/`request` actions only — no decision action exists. `list` returns every gate with its pending count and latest decision; `request` returns the recorded request, the rule decision when one fired, or the approval-channel outcome, with an explicit note when no answerer is available and the request stays pending.

#### Token effect

Schema cost is fixed; results are small (gate roster size and one decision), independent of the request count history.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. The gate roster is closed by the service, so the schema does not drift with request activity.

### ia_knowledge tool

#### What the model sees

The generated [`ia_knowledge` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-ia) with `search`/`record`/`readiness`. Search hits always carry `source` and `version` citations plus `matchedTerms`, and results flag `degraded: true` below the cold-start scale; `record` returns the new entry id with its `pending-review` status.

#### Token effect

Schema cost is fixed; result size scales with the hit count, capped by `maxSearchResults`.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged; the closed library enum keeps the schema independent of recorded content.

### ia_project tool

#### What the model sees

The generated [`ia_project` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-ia) with `init`/`list`/`status`/`advance`/`submit`. Snapshots render stages with state, attempts, gate status, latest verification reports, escalation packages, and human instructions; `submit` returns the updated stage only.

#### Token effect

Schema cost is fixed; result size scales with the stage count (six in the shipped template) and the report size on failing submissions.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged; stage activity never changes the schema.

## Known Limitations and Deferred Work

- **No tool reads back raw artifacts** — `ia_project` snapshots carry the latest reports, not the full submission text beyond escalation packages; the model keeps its own working copy.
- **Per-agent current project only** — `ia_project` remembers one project per agent; multi-project agents pass `projectId` explicitly.
- **Gate decisions depend on a composed answerer** — without an approval answerer the request stays pending and the tool says so; the ACP bridge or Web GUI supplies one in real deployments.
