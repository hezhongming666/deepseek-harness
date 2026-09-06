# @deepseek-ai/dsh-ia-trace

English | [中文](README.zh.md)

The append-only traceability graph of the engineering loop: requirement/design/implementation/test/change nodes, typed directed edges, change records, and the three-level change-impact analysis from the architecture §4.4. Projects are isolated by a caller-chosen scope key — the tool consumer uses the agent's session id, so cross-project leakage is impossible by construction (§3.10).

## Configuration

| key | meaning |
|---|---|
| `dataDir` | Directory the trace graphs persist to; default empty = in-memory only. Non-empty restores every scoped project from `<dataDir>/ia-trace.json` at load and snapshots after every mutation. |

## Service API

`ctx.iaTrace`:

- `project(scope)` — open (or reuse) the isolated project under one scope key.
- `hasProject(scope)` — whether a scope already has a project.
- `onProjectOpen(listener)` — per-new-project hook used by the invariant companion.

`TraceProject`:

- `addNode({ kind, title, detail?, tags?, author, basis? })` — record one node; ids are service-issued `node-<n>`.
- `addLink(from, to, kind)` — add one typed edge (`derives` | `implements` | `verifies` | `changes`); unknown endpoints and duplicate edges throw.
- `recordChange({ nodeIds, author, reason })` — bump the touched nodes' change versions, append the record, and return the forward impact analysis.
- `impactOf(nodeIds)` — three levels: `direct` (immediate successors), `indirect` (deeper transitive successors), `potential` (tag-sharing but unreachable — advisory, model-assisted, human-confirmed).
- `matrix()` — per requirement: its reachable implementations and tests plus the coverage verdict.
- `nodesList()` / `linksList()` / `changesList()` — full snapshots.

Nodes, links, and change records are added only — supersession happens through new change records, never edits. The invariant companion proves after every committed mutation that links reference existing nodes and every node's `changeVersion` equals its change-record count.

## Persistence

With `dataDir` configured, every committed mutation — `addNode`, `addLink`, `recordChange` — writes one atomic versioned snapshot (`ia-trace.json`) covering all scoped projects; a fresh boot restores every project with its nodes, links, change records, timestamps, and issuing ordinal. A corrupt or wrong-version snapshot fails at load, and a failed snapshot write throws while the in-memory commit stands (the disk may lag memory until the next successful save).

## Model Experience

Indirectly, through dsh-tool-ia's `ia_trace` tool, which is the only model-facing surface that renders this graph.

#### KV Cache effect

Independent. The graph keeps no request-scoped state and registers no prompt or tool schema; trace content enters requests only as `ia_trace` tool results.

## Known Limitations and Deferred Work

- **Snapshot, not a journal** — persistence is one atomic JSON snapshot per data directory (fsync durability out of scope); with `dataDir` unset, projects stay in memory and the session log's `tool/result` records remain the only durable trace.
- **Potential impacts are a tag heuristic** — semantic relatedness beyond shared tags is exactly the design's model-assisted, human-confirmed tier, so `potential` is advisory only.
- **No cross-project queries** — the service exposes no union or search across scope keys, matching the per-project isolation rule.
