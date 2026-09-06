# @deepseek-ai/dsh-ia-orchestrator

English | [中文](README.zh.md)

The project orchestrator (§3.10): a DAG stage machine with verify-then-gate transitions, the bounded inner loop (§4.1), and escalation packages (§4.2). Projects are isolated by id; the orchestrator reads gate decisions back from the gate engine and never makes them (§3.10 治理约束).

## Configuration

| key | meaning |
|---|---|
| `template` | The template `initProject` instantiates by default: `conveyor-line`. Unknown names fail at load. |
| `dataDir` | Directory the project state persists to; default empty = in-memory only. Non-empty restores all projects from `<dataDir>/ia-orchestrator.json` at load and snapshots after every mutation. |

## The `conveyor-line` template

```
requirements ── design ── control-program ── simulation ── commissioning ── acceptance
```

| Stage | Verifiers | Gate |
|---|---|---|
| `requirements` | — | `requirement-baseline` |
| `design` | — | `design-review` |
| `control-program` | `st-syntax`, `st-lint`, optional `tia-compile` | — |
| `simulation` | — | `release-review` (project gate) |
| `commissioning` | — | `first-power-on` |
| `acceptance` | — | `acceptance-signoff` |

Optional verifiers run only when a provider registered the kind in the composed verifier registry; `tia-compile` comes from `@deepseek-ai/dsh-ia-verifier-openness` and adjudicates the same submission through a real TIA Portal compile. Local kinds read the submission `text`; `tia-compile` reads the optional `vendorSource` and falls back to `text`, so one submission carries the harness `PROGRAM` dialect for the local checks and the TIA SCL block for the vendor compile.

Stage states: `pending → running → (repair ↺ | gated | passed | escalated)`. A submission runs the bound verifiers first; failures return `repair` with the reports until the retry budget (default 3, §4.1) is exhausted, then the stage escalates with a package of context, artifact, evidence, failure summary, and supervisor options (§4.2). Bound gates stop the stage at `gated`; an approved decision passes it, a rejected one returns it to `running` for rework.

## Service API

`ctx.iaOrchestrator`:

- `initProject(projectId?, templateName?)` — instantiate a project; the first stage starts `running`.
- `project(projectId)` / `projectsList()` — snapshots, syncing bound gate decisions first.
- `advance(projectId, stageId)` — start a `pending` stage; all predecessors must have passed.
- `submit(projectId, stageId, submission)` — run verifiers, then gate or pass, repair, or escalate.
- `resolveEscalation(projectId, stageId, instruction)` — supervisor path: back to `running` with a fresh budget and the instruction attached. No model-facing tool exposes it.
- `exportAudit(projectId)` — the §5.4 audit package: every stage's machine state plus the complete request-and-decision history of its bound gate.
- `templatesList()` — registered template names.

When a submission passes after failing in the same inner-loop run, the learning pipeline (§4.3) sediments the failure-repair pair into the optional knowledge service as one `pending-review` case; the sink's duplicate rejection is the dedup gate, and no sink failure ever blocks a passed stage.

At load the service validates every bound verifier kind against the composed registry and registers the `release-review` gate — misconfiguration fails loud. The invariant companion proves the stage machine after every mutation: no stage runs ahead of an unpassed predecessor, attempts never exceed the budget, escalated stages carry their package, and passed verifier-bound stages hold only passing reports.

## Persistence

With `dataDir` configured, every committed mutation — project instantiation, advances, submissions in every branch, escalation resolutions, and gate-decision syncs folded in on read — writes one atomic versioned snapshot (`ia-orchestrator.json`); a fresh boot restores all projects with their stage machines, attempts, latest reports, escalations, instructions, and the project-id ordinal, re-binding each stage to its template node. A corrupt or wrong-version snapshot fails at load, and a failed snapshot write throws while the in-memory commit stands (the disk may lag memory until the next successful save).

## Model Experience

Indirectly, through dsh-tool-ia's `ia_project` tool, which is the only model-facing surface that drives this DAG.

#### KV Cache effect

Independent. The orchestrator keeps no request-scoped state and registers no prompt or tool schema; project state enters requests only as `ia_project` tool results.

## Known Limitations and Deferred Work

- **Snapshot, not a journal** — persistence is one atomic JSON snapshot per data directory (fsync durability out of scope); with `dataDir` unset, stage state stays in memory and the session log's tool-visible transitions remain the only durable record.
- **Linear template chain** — custom DAG topologies (parallel hmi/electrical stages, ops-loop re-entry) require registering additional templates; only `conveyor-line` ships.
- **Escalation resolution is human-only** — no rule can resolve an escalation; the supervisor path is the `resolveEscalation` service API.
