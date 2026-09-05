# Agent Note: Industrial-automation closed loop as a dsh capability family

Status: implemented

English | [中文](2026-09-05-industrial-automation-closed-loop-family.zh.md)

## Problem

The industrial-automation design (design-proposals/工业自动化AI-Agent闭环架构-v1.1.docx and its Markdown twin) specifies a multi-agent engineering loop whose core disciplines are governance, not generation: deterministic verify-as-gate adjudication (§2.3), mandatory human gates with A0–A3 automation levels (§5.1/§5.2), append-only traceability with three-level change-impact analysis (§4.4), cold-start-gated knowledge libraries (§6.2), and a DAG orchestrator with a bounded inner loop and escalation packages (§3.10/§4). The harness has no capability family realizing these disciplines, and nothing in the existing extension surface (spec-loop's parameter-search engine, the approval seam) covers them.

## Decision

**A new `industrial/` capability family with five services, one verifier provider, and one tool package.** The design's mechanisms map one-to-one onto packages: `ia-verifier` (deterministic validator registry with built-in ST syntax/lint and IO-symbol consistency validators), `ia-verifier-openness` (the `tia-compile` kind, a real TIA Portal compile adjudication over the Openness bridge — see [the bridge integration note](2026-09-05-industrial-verifier-openness-bridge.md)), `ia-trace` (append-only node/link/change graph with three-level impact analysis), `ia-gates` (six mandatory gates, A0–A3 levels, always-human dangerous gates), `ia-knowledge` (standards/templates/cases libraries with mandatory citations and cold-start readiness), `ia-orchestrator` (conveyor-line DAG stage machine with verify-then-gate transitions, retry budget 3, escalation packages), and `tool-ia` (the five model-facing tools). The `dsh-ia` bundle and the `examples/industrial-ia` overlay ship the complete composition; the openness verifier stays out of the bundle because its `url` is deployment-owned and required.

**The authority boundary is structural, not procedural.** No tool schema exposes a gate decide, a knowledge approve, or an escalation-resolution action; the gate engine has no public decide method at all — decisions enter only through the composed approval channel (`ctx.approval`, failing closed when absent) or a registered auto-release rule evaluated at A2/A3. The tool package's invariant companion proves the registered `ia_gate` schema never grows a decision action.

**Deterministic validators are self-contained and local.** The ST subset lexer/parser and the lint/IO checks are pure TypeScript with no external tool dependency, honoring the design's "验证器自持、本地化、不依赖模型" and "不具备自动化接口的环节宁可人工也不可假自动": the simulation stage has no fake validator — it gates on human release review.

**In-memory domain state with tool-result logging.** Trace projects, gate requests, knowledge entries, and orchestrator projects live for the service lifetime; everything model-visible flows through tool results, which the session log records, so the "model-visible means logged" invariant holds without touching `SessionEventMap`. Durable per-project storage (§5.5) is the deferred-work list on each README.

## Alternatives considered

- **Extending spec-loop** — its adapter seam is a parameter-search loop over one software integration, not a registry of named adjudication checks; gate/trace/knowledge disciplines have no place there.
- **Session-event-backed domain stores** — would put project data into the conversation log and require `SessionEventMap` additions plus both SDK projection updates; tool-result logging already satisfies the model-visibility invariant at a fraction of the surface.
- **One monolithic `dsh-ia` package** — the five services have independent consumers (the tool package composes them, the orchestrator binds two) and independent lifecycles; a single package would merge five ctx keys and their invariants into one release unit.
- **Provider-separated verifier family** — a separate ST provider package adds seam ceremony without a second provider today; the registry API is the extension point a vendor compile adapter registers through. Realized by `ia-verifier-openness`: once a real TIA compile provider existed, it shipped as its own package registering the `tia-compile` kind, while the registry stayed provider-agnostic.

## Consequences

Bought: the closed-loop disciplines exist as composable, independently testable services (94 package tests including a real Loader boot); deployment is one bundle row set or one overlay; every gate release is provably unreachable from the model surface.

Cost: in-memory state resets on restart (documented per package), the local ST validator is a subset checker — the real vendor compile is the separate `tia-compile` channel — and the default DAG is a linear six-stage template — custom topologies are the stated extension points rather than shipped breadth.
