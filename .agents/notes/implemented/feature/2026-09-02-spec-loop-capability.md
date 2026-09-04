# Agent Note: Spec-loop capability — deterministic parameter search as a model tool

Status: implemented

English | [中文](2026-09-02-spec-loop-capability.zh.md)

## Problem

The shell/core split wants a deterministic core for batch parameter search: DSH (the shell) selects specs, schedules, reports, and interacts with humans, while a core loop over external engineering software produces and evaluates candidates en masse — replayable, bounded, zero-human, cost-capped. The loop needs a spec contract (objective + numeric assertions as acceptance), a failure classification that separates repairable assertion misses from input-invalid, divergence, and infrastructure failures, monotonic repair with an epsilon margin, and iteration/wall-clock/token caps. The model-facing surface is one tool call that runs the whole loop and returns the complete audit trail.

## Decision

New group `packages/spec-loop` with three packages. `@deepseek-ai/dsh-spec-loop` owns the loop: `runSpecLoop` (the deterministic engine), `validateSpec` + `SpecLoopError('INVALID_SPEC')` (the wire-boundary spec validator), the branded `SpecLoopRunId`, and `SpecLoopAdapterService` (ctx key `specLoopAdapter`) — the adapter seam industrial-software integrations implement (`validate` is the cheap S1 gate, `run` executes with a cancellation signal and reports `success`/`diverged`/`infrastructure`/`killed` plus structured metrics, license time, and the version tuple). `@deepseek-ai/dsh-tool-spec-loop` registers the `spec_loop` tool and owns generation through the LLM seam: a required ordered `models` fallback chain (each proposal tries every target in order), deployment ceilings (`maxIterations`/`maxWallClockMs`/`maxTokens` plus per-call bounds), and the bounded rendered report. `@deepseek-ai/dsh-provider-openness`, added by the [Openness provider note](2026-09-04-openness-spec-loop-adapter.md), ships the TIA Portal Openness adapter over an HTTP JSON bridge.

Each candidate is classified exactly once: `satisfied`, `S0` (assertions failed — the only repairable class), `S1` (envelope or validation refusal; never reaches the software), `S2` (divergence), `S3` (adapter threw or reported infrastructure failure), `generation-failed` (every fallback model failed), or `cancelled`. Monotonic repair replaces the current best only on improvement beyond `repair.margin`; `maxNoImprovement` consecutive misses stop the run, as do `maxConsecutiveInfrastructure` consecutive S3 and the iteration/wall-clock/billed-token budgets (the minimum of the spec budgets and the deployment ceilings). The report carries the full per-iteration audit trail, the best accepted candidate, and summed costs. All bookkeeping is a pure function of the generation and adapter outcome sequence, so a replay is a run whose generator feeds logged proposals back — the engine needs no replay mode.

Documentation: [docs/subsystems/spec-loop.md](../../../../docs/subsystems/spec-loop.md) owns the vocabulary with its generated Cordis API region; the tool schema sits in the generated [tool catalog](../../../../docs/tool-catalog.md#deepseek-aidsh-tool-spec-loop).

## Alternatives considered

**Why not reuse the workflow engine (model-written scripts + subagents)?** A script would own the loop's control flow, but spec-loop's whole value is that the loop shape, failure routing, and budget enforcement are fixed and testable; generation is a raw structured-JSON model call with a fallback chain, not fresh child agents.

**Why not route generation through subagent providers?** Heavier than the need: candidate proposal needs one bounded JSON reply per iteration, and multi-model fallback wants direct LLM-seam calls with per-call usage accounting; subagents bring child sessions and depth policy the loop does not use.

**Why no named-provider adapter registry?** One adapter per context matches one-software-per-deployment; a registry adds selection policy no current consumer needs. A second adapter replaces the first through plugin configuration.

**Why no shipped CLI adapter provider?** No deployment owned one when the capability shipped, so tests use deterministic in-process fakes and the tool fails loud when no `specLoopAdapter` is mounted. The [Openness provider](2026-09-04-openness-spec-loop-adapter.md) later shipped an HTTP-bridge provider; a stdio CLI provider and telemetry parsing stay deferred.

## Consequences

Bought: a bounded, replayable search loop mounted as one model tool; S1/S2/S3 separated from repairable S0; epsilon-margined monotonic best tracking; spec budgets tightened by deployment ceilings; a per-iteration audit trail and summed cost report; adapter providers report failures through outcome statuses, never exceptions.

Given up: no telemetry-stream early termination (an adapter approximates it by returning `diverged`); license time is summed and reported, never enforced against a pool; budgets are per-run (no persistent daily ledger); specs are inline per call (no named registry); envelope violations are classified S1, with no mid-run human approval; the tool is wired into an example overlay (`examples/openness-spec-loop/cordis.yml`) with an assembled-Web keyless e2e (`apps/web/tests/openness-spec-loop.e2e.ts`), not a model-keyed snapshot, because recording one needs an API key — the Loader-composition, agent-stack integration, and web e2e tests are the real-composition coverage. The tool catalog and cordis catalog currently fail full regeneration on two gaps owned by the in-flight vision packages (their missing catalog manifest and `LINK_MAP` entries), not by this capability.
