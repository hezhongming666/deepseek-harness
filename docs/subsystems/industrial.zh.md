# 工业自动化闭环

[English](industrial.md) | 中文

工业自动化能力族实现闭环架构（[设计 v1.1](../../design-proposals/industrial-automation-ai-agent-closed-loop-architecture.md)）：确定性的"验证即门禁"裁决、带 A0–A3 自动化等级的强制人工闸门、只追加追溯、冷启动门控知识库，以及 DAG 项目编排器。与 [spec-loop](spec-loop.md) 一样，它是**一个可选能力族**，不是 agent loop 的一部分。

服务定义：[dsh-ia-verifier](../../packages/industrial/ia-verifier)（`ctx.iaVerifiers`）、[dsh-ia-trace](../../packages/industrial/ia-trace)（`ctx.iaTrace`）、[dsh-ia-gates](../../packages/industrial/ia-gates)（`ctx.iaGates`）、[dsh-ia-knowledge](../../packages/industrial/ia-knowledge)（`ctx.iaKnowledge`）与 [dsh-ia-orchestrator](../../packages/industrial/ia-orchestrator)（`ctx.iaOrchestrator`）。面向模型的消费方是 [dsh-tool-ia](../../packages/industrial/tool-ia)，注册 `ia_verify`、`ia_trace`、`ia_gate`、`ia_knowledge` 与 `ia_project` 工具。组合以 [`dsh-ia` bundle](../../packages/bundle/ia/README.md) 与 [industrial-ia 示例](../../examples/industrial-ia/README.md) 交付。

## 权限边界

闸门裁决只经组合好的审批通道（`ctx.approval`，缺失时失败关闭）或在自动化等级 A2/A3 生效的已注册自动放行规则进入。危险闸门在任何等级下保持人工，任何面向模型工具 schema 都不暴露裁决、批准或升级解决动作。每个包的 invariant 伴随插件（`./invariant`）在运行时证明其拥有的关系。

## 来源

词汇表位于各包的 `src/types.ts`：[verifier](../../packages/industrial/ia-verifier/src/types.ts)（报告、诊断、证据）、[trace](../../packages/industrial/ia-trace/src/types.ts)（节点、边、影响分析）、[gates](../../packages/industrial/ia-gates/src/types.ts)（等级、定义、裁决）、[knowledge](../../packages/industrial/ia-knowledge/src/types.ts)（库、引用、就绪）与 [orchestrator](../../packages/industrial/ia-orchestrator/src/types.ts)（模板、阶段、升级包）。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxiagates--iagatesservice"></a>

### `ctx.iaGates` — `IaGatesService`

The gate engine. Requests are append-only records; decisions enter through IaGatesService.requestHumanDecision (the approval channel) or a registered auto-release rule evaluated at level A2/A3.

```ts cordis-catalog
/** Read the deployment automation level.
 * @returns the deployment automation level. */
automationLevel(): AutomationLevel

/**
 * Register one project-specific gate. Mandatory gate ids are reserved and
 * cannot be re-registered.
 * @param definition - the gate definition; `mandatory` is forced to false.
 * @returns a disposer removing the gate.
 */
registerGate(definition: GateRegistration): () => void

/**
 * Register one auto-release rule. Rules apply only at automation level A2
 * or A3, and never to always-human gates.
 * @param id - the rule id, used as the decision's decider label.
 * @param gateId - the target gate.
 * @param rule - the deterministic predicate over the request context.
 * @returns a disposer removing the rule.
 */
registerAutoReleaseRule(id: string, gateId: GateId, rule: AutoReleaseRule): () => void

/** List every registered gate.
 * @returns all registered gates, mandatory first. */
gatesList(): GateDefinition[]

/** List every recorded request.
 * @returns all requests across gates, in recording order. */
requests(): GateRequest[]

/** Read the requests recorded for one gate.
 * @param gateId - the gate whose requests to read.
 * @returns the requests recorded for the gate, oldest first. */
requestsFor(gateId: GateId): GateRequest[]

/**
 * Ask one gate to release. At level A2/A3 a registered auto-release rule
 * decides immediately; otherwise the request stays pending for the human
 * channel.
 * @param gateId - the gate to ask.
 * @param requestedBy - the asking agent or human identity.
 * @param context - the decision context.
 * @returns the recorded request, possibly already decided.
 */
request(gateId: GateId, requestedBy: string, context: GateRequestContext): GateRequest

/**
 * Ask the composed approval channel for a human decision on the latest
 * pending request of one gate. The service itself never prompts anyone —
 * the approval seam does — and any answer that is not a grant leaves the
 * request pending.
 * @param gateId - the gate to decide.
 * @param agent - the agent on whose behalf the question is asked.
 * @returns what happened: `approved`, `rejected`, or `pending` when the
 *   channel is absent, unavailable, cancelled, or has no pending request.
 */
async requestHumanDecision(gateId: GateId, agent: Agent): Promise<HumanDecisionOutcome>

/** Read the latest decision recorded for one gate.
 * @param gateId - the gate whose decision to read.
 * @returns the latest decision, or `undefined` when none exists. */
latestDecision(gateId: GateId): GateDecision | undefined

/** Subscribe to post-mutation notifications; the registration lives as long as the service.
 * @param listener - called after every committed mutation. */
onMutate(listener: () => void): void
```

Types: [Agent](core.md)

Source: [`packages/industrial/ia-gates/src/index.ts:101`](../../packages/industrial/ia-gates/src/index.ts)

<a id="ctxiaknowledge--iaknowledgeservice"></a>

### `ctx.iaKnowledge` — `IaKnowledgeService`

The knowledge service. Entries are append-only records keyed per library; duplicate title+content records are rejected so the learning pipeline cannot pollute a library twice.

```ts cordis-catalog
/**
 * Record one entry. Duplicate title+content pairs in one library are
 * rejected, and citations are mandatory — the design's evidence rule.
 * @param input - the entry to record.
 * @returns the recorded entry.
 */
record(input: RecordEntryInput): KnowledgeEntry

/**
 * Approve one pending entry — the human quality-gate path (§6.2 抽检).
 * @param id - the entry to approve.
 * @returns the updated entry.
 * @throws when the id is unknown or the entry is already approved.
 */
approveEntry(id: KnowledgeEntryId): KnowledgeEntry

/** List the entries of one library.
 * @param library - the library to list.
 * @returns all entries of the library, in recording order. */
entriesList(library: LibraryKind): KnowledgeEntry[]

/**
 * List the closed library kinds.
 * @returns the three library kinds, in canonical order.
 */
libraries(): LibraryKind[]

/**
 * Deterministic keyword retrieval over one library: every query term must
 * match somewhere in the entry, hits are ranked by total match count and
 * capped at the configured maximum.
 * @param library - the library to search.
 * @param query - whitespace-separated search terms.
 * @returns the bounded hits plus the cold-start degradation flag.
 */
search(library: LibraryKind, query: string): SearchResult

/** Snapshot the cold-start readiness.
 * @returns the cold-start readiness snapshot (§6.2 minimum scales). */
readiness(): Readiness

/** Subscribe to post-mutation notifications; the registration lives as long as the service.
 * @param listener - called after every committed mutation. */
onMutate(listener: () => void): void
```

Source: [`packages/industrial/ia-knowledge/src/index.ts:74`](../../packages/industrial/ia-knowledge/src/index.ts)

<a id="ctxiaorchestrator--iaorchestratorservice"></a>

### `ctx.iaOrchestrator` — `IaOrchestratorService`

The project orchestrator. Projects are isolated by id; the service owns no approval authority — gate decisions are read back from the gate engine.

```ts cordis-catalog
/** List the registered template names.
 * @returns the registered template names. */
templatesList(): string[]

/**
 * Instantiate one project from a template. Every stage starts `pending`
 * except the first, which starts `running`.
 * @param projectId - explicit project id, or a service-issued one.
 * @param templateName - the template to instantiate (default: configured).
 * @returns the project snapshot.
 */
initProject(projectId?: ProjectId, templateName: string = this.defaultTemplate): ProjectSnapshot

/**
 * Read one project snapshot, syncing bound gate decisions first: an
 * approved gate passes a `gated` stage, a rejected gate sends it back to
 * `running` for rework.
 * @param projectId - the project to read.
 * @returns the current snapshot.
 */
project(projectId: ProjectId): ProjectSnapshot

/** List every instantiated project.
 * @returns all instantiated projects, snapshotted with synced gate decisions. */
projectsList(): ProjectSnapshot[]

/**
 * Start a `pending` stage; every predecessor stage must have passed.
 * @param projectId - the owning project.
 * @param stageId - the stage to start.
 * @returns the updated project snapshot.
 */
advance(projectId: ProjectId, stageId: StageId): ProjectSnapshot

/**
 * Submit one artifact into a `running` or `repair` stage: run the bound
 * verifiers, then request the bound gate on success, retry on failure
 * within the budget, and escalate when the budget is exhausted.
 * @param projectId - the owning project.
 * @param stageId - the receiving stage.
 * @param submission - the artifact text, optional vendor-dialect source, and submitter identity.
 * @returns the updated stage snapshot.
 */
async submit(projectId: ProjectId, stageId: StageId, submission: Submission): Promise<StageSnapshot>

/**
 * Resolve one escalated stage with a human instruction: the stage returns
 * to `running` with a fresh inner-loop budget and the instruction attached
 * for the agent to read. This is a supervisor path — no model-facing tool
 * exposes it.
 * @param projectId - the owning project.
 * @param stageId - the escalated stage.
 * @param instruction - what the supervisor asks the agent to do.
 * @returns the updated stage snapshot.
 */
resolveEscalation(projectId: ProjectId, stageId: StageId, instruction: string): StageSnapshot

/** Subscribe to post-mutation notifications; the registration lives as long as the service.
 * @param listener - called after every committed mutation. */
onMutate(listener: () => void): void
```

Source: [`packages/industrial/ia-orchestrator/src/index.ts:146`](../../packages/industrial/ia-orchestrator/src/index.ts)

<a id="ctxiatrace--iatraceservice"></a>

### `ctx.iaTrace` — `IaTraceService`

The traceability service. It owns no project state itself — callers open per-scope projects through IaTraceService.project — but keeps the scoped projects alive until the service disposes.

```ts cordis-catalog
/**
 * Open (or reuse) the project isolated under one scope key.
 * @param scope - the caller-chosen isolation key, e.g. the agent's session id.
 * @returns the scoped project.
 */
project(scope: string): TraceProject

/**
 * Subscribe to first-open notifications; the registration lives as long as
 * the service (used by the invariant companion to attach validation).
 * @param listener - called once per newly opened project, after it commits.
 */
onProjectOpen(listener: (project: TraceProject) => void): void

/**
 * Check whether one scope key has a project.
 * @param scope - the isolation key to check.
 * @returns whether the scope key already has a project.
 */
hasProject(scope: string): boolean
```

Source: [`packages/industrial/ia-trace/src/index.ts:301`](../../packages/industrial/ia-trace/src/index.ts)

<a id="ctxiaverifiers--iaverifiers"></a>

### `ctx.iaVerifiers` — `IaVerifiers`

The named deterministic-validator registry. Extension providers register additional kinds (e.g. a vendor compile adapter); gate and orchestrator consumers read reports through IaVerifiers.verify.

```ts cordis-catalog
/**
 * Register one named validator. Registration is an effect: the returned
 * disposer removes the kind again.
 * @param descriptor - the validator to register.
 * @returns a disposer removing the registration.
 */
register(descriptor: ValidatorDescriptor): () => void

/**
 * List the registered validator kinds.
 * @returns the registered validator kinds, in registration order.
 */
kinds(): string[]

/**
 * Read one registered validator descriptor.
 * @param kind - the validator kind.
 * @returns the descriptor, or `undefined` when the kind is unregistered.
 */
get(kind: string): ValidatorDescriptor | undefined

/**
 * Run one deterministic verification.
 * @param kind - the registered validator kind.
 * @param input - the checked text or JSON payload.
 * @returns the verification report, awaited when the validator round-trips
 *   an external tool.
 * @throws {@link UnknownVerifierError} when the kind is unregistered — the
 *   design's fail-loud rule: verification never silently skips.
 */
async verify(kind: string, input: VerificationInput): Promise<VerificationReport>

/**
 * Run several verifications over one input in the given order.
 * @param kinds - the validator kinds to run.
 * @param input - the checked text or JSON payload.
 * @returns one report per kind, in the requested order.
 * @throws {@link UnknownVerifierError} on the first unregistered kind.
 */
async verifyAll(kinds: readonly string[], input: VerificationInput): Promise<VerificationReport[]>
```

Source: [`packages/industrial/ia-verifier/src/index.ts:53`](../../packages/industrial/ia-verifier/src/index.ts)
<!-- END GENERATED cordis-surface -->
