# Agent Note: Industrial state persistence and the learning pipeline

Status: implemented

English | [中文](2026-09-05-industrial-state-persistence-learning-pipeline.zh.md)

## Problem

The conformity audit found the industrial family's biggest deviation from the v1.1 design: §5.5 state persistence. Projects, trace graphs, gate decisions, and knowledge entries lived only in memory, so a process restart wiped the stage machines, the decision history, and the libraries; §5.4's per-project audit package and §4.3's automatic learning pipeline were also absent.

## Decision

**Versioned JSON snapshots per stateful service, enabled by a `dataDir` config.** Each of `ia-gates`, `ia-knowledge`, `ia-trace`, and `ia-orchestrator` gained a `dataDir` (default empty = in-memory). When set, the constructor restores synchronously from `<dataDir>/<service>.json` and every committed mutation writes one atomic snapshot through the shared `readJsonSnapshot`/`writeJsonSnapshot` helpers added to `dsh-atomic-write` (exclusive-create temp + rename, version-checked, fail loud on corruption or drift). A failed snapshot write throws after the memory commit — the disk may lag memory until the next successful save, documented per package. Snapshot, not journal: fsync durability is out of scope.

**Registration effects are never persisted.** Gate definitions and auto-release rules are code; owners re-register them at boot, so a restored gate simply continues its restored request history. Restored orchestrator stages re-bind to their template nodes, and gate-decision syncs folded in on read persist too.

**Audit export.** `exportAudit(projectId)` assembles the §5.4 package: every stage's machine state plus the complete request-and-decision history of its bound gate; the `ia_project` tool gained the `export` action.

**Learning pipeline.** When a submission passes after failing in the same inner-loop run, the orchestrator sediments the failure-repair pair into the optional `ctx.iaKnowledge` (read through `ctx.get`, never injected) as one `pending-review` case; the sink's duplicate rejection is the dedup gate, and every sink failure is swallowed because draft sedimentation must never block a passed stage.

## Alternatives considered

- **The storage hub (`ctx.storage`)** — real backends and data forms exist, but wiring four services through the hub forces every deployment to compose storage plus a backend for a feature the family needs standalone; synchronous load-time restore also rules out the hub's async IO.
- **Persisting gate definitions** — conflicts on every boot: the orchestrator re-registers `release-review`, and any deployment re-registering a project gate would hit the restored duplicate. Definitions are registration effects; only requests and decisions are data.
- **A translator or a fake simulator instead of honest seams** — the dialect split stays bridged by the explicit `vendorSource` second source, and the simulation stage still gates on human release review until a real simulation target exists.

## Consequences

Bought: restart survival for the four state stores, an exportable audit chain, and an automatic learning sink with dedup — the three audit gaps are closed, with 137 package tests, a 23-check assembled smoke including a cross-boot restore phase, and full gates green.

Cost: one more shared util surface; persistence stays opt-in per deployment (`dataDir`), so unconfigured profiles keep the old in-memory semantics; snapshots are atomic but not fsynced.
