# @deepseek-ai/dsh-ia-gates

English | [中文](README.zh.md)

The gate engine — the architecture's 人机边界 (§5.1/§5.2). The six mandatory human gates ship with the service and cannot be removed or re-registered; dangerous gates stay human at every automation level; decisions enter only through the human approval channel or a registered auto-release rule evaluated at A2/A3. Agents request gates, never decide them.

## Configuration

| key | meaning |
|---|---|
| `level` | Deployment automation level `A0`–`A3`, default `A1` (§5.1). Anything else fails at load. |
| `dataDir` | Directory the gate-engine state persists to; default empty = in-memory only. Non-empty restores requests and decisions from `<dataDir>/ia-gates.json` at load and snapshots after every mutation. |

## The six mandatory gates

| id | Always human |
|---|---|
| `requirement-baseline` | no — auto-release rules allowed at A2/A3 |
| `design-review` | no — auto-release rules allowed at A2/A3 |
| `sil-review` | yes — certified-engineer sign-off |
| `first-power-on` | yes — dangerous operation at every level |
| `acceptance-signoff` | yes |
| `online-change` | yes — production-affecting changes |

## Service API

`ctx.iaGates`:

- `automationLevel()` — the configured level.
- `registerGate(definition)` — add a project gate; mandatory ids are reserved. Returns the removal disposer.
- `registerAutoReleaseRule(id, gateId, rule)` — register a deterministic release predicate; targeting an always-human gate throws `AlwaysHumanGateError`.
- `gatesList()` / `requests()` / `requestsFor(gateId)` — definitions and append-only request records.
- `request(gateId, requestedBy, context)` — ask one gate; at A2/A3 a registered rule decides immediately, otherwise the request stays pending.
- `requestHumanDecision(gateId, agent)` — round-trip the composed approval channel for the latest pending request: `allowed-once` approves, `rejected` rejects, anything else leaves it pending (fail closed).
- `latestDecision(gateId)` — the newest decision, when one exists.

There is no public decide method: the only decision paths are the approval channel and rule evaluation, both inside the service. The invariant companion proves the mandatory roster, its fixed always-human classification, and that always-human gates are never decided by a rule.

## Persistence

With `dataDir` configured, every committed mutation — requests and decisions — writes one atomic versioned snapshot (`ia-gates.json`); a fresh boot restores all requests with decisions and the request ordinal. Gate definitions and auto-release rules are registration effects (code) and are never persisted: their owners re-register them at boot, so a re-registered gate simply continues its restored request history. A corrupt or wrong-version snapshot fails at load, and a failed snapshot write throws while the in-memory commit stands (the disk may lag memory until the next successful save).

## Model Experience

Indirectly, through dsh-tool-ia's `ia_gate` tool, which is the only model-facing surface and exposes request/list actions only.

#### KV Cache effect

Independent. The engine keeps no request-scoped state and registers no prompt or tool schema; gate state enters requests only as `ia_gate` tool results.

## Known Limitations and Deferred Work

- **Snapshot, not a journal** — persistence is one atomic JSON snapshot per data directory (crash durability via fsync is out of scope); with `dataDir` unset, state stays in memory and the approval channel's audit events remain the only durable record.
- **Rule release is per-service, not per-project** — A2 standard-project scoping (rules per project template) is deferred; rules apply service-wide today.
- **No approval-policy override of always-human gates** — even a `never` approval policy leaves those gates pending; a human channel outside the approval seam must drive them.
