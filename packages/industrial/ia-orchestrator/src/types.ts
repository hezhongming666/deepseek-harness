/**
 * Shared vocabulary of the orchestration layer: the DAG template, stage
 * states, verification submissions, and escalation packages.
 * @module @deepseek-ai/dsh-ia-orchestrator
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { GateId, GateRequest } from '@deepseek-ai/dsh-ia-gates'
import type { VerificationReport } from '@deepseek-ai/dsh-ia-verifier'

/** Opaque id of one orchestrated project. */
export type ProjectId = Branded<'ProjectId'>

/**
 * Brand a string as a {@link ProjectId}.
 * @param value - the opaque project identifier.
 * @returns the same string, branded; no validation is performed.
 */
export function ProjectId(value: string): ProjectId {
  return value as ProjectId
}

/** Opaque id of one DAG stage. */
export type StageId = Branded<'StageId'>

/**
 * Brand a string as a {@link StageId}.
 * @param value - the opaque stage identifier.
 * @returns the same string, branded; no validation is performed.
 */
export function StageId(value: string): StageId {
  return value as StageId
}

/**
 * Stage lifecycle states:
 * `pending` awaits its predecessors, `running` awaits an artifact, `repair`
 * awaits a corrected artifact after a failed verification, `gated` awaits a
 * gate decision, `escalated` awaits a human resolution, `passed` flows
 * downstream.
 */
export type StageState = 'pending' | 'running' | 'repair' | 'gated' | 'escalated' | 'passed'

/** One DAG template node: what a stage runs and who gates it. */
export interface StageTemplate {
  /** Opaque stage id. */
  id: StageId
  /** Human-readable stage title. */
  title: string
  /** Verifier kinds run on every submission, in order. */
  verifiers: string[]
  /**
   * Verifier kinds run when they are registered — an adapter the deployment
   * may or may not mount (e.g. `tia-compile`). Unregistered kinds are skipped
   * by design, never a misconfiguration.
   */
  optionalVerifiers?: string[]
  /** The gate that releases this stage after verification, when bound. */
  gate?: GateId
  /** Maximum failing submissions before escalation (the inner loop, §4.1). */
  maxRetries: number
  /** What the stage produces — the model-visible work description. */
  description: string
}

/** One DAG template: an ordered stage chain. */
export interface DagTemplate {
  /** Template name, e.g. `conveyor-line`. */
  name: string
  /** Stages in dependency order; edges run from each stage to the next. */
  stages: StageTemplate[]
}

/** One artifact submission into a stage. */
export interface Submission {
  /** The artifact text (ST source or JSON payload for the bound verifiers). */
  text: string
  /**
   * Optional vendor-dialect source for external compile verifiers, e.g. the
   * TIA SCL block a bound `tia-compile` imports. Local verifiers ignore it.
   */
  vendorSource?: string
  /** Optional artifact reference, e.g. a trace node id. */
  reference?: string
  /** Who submitted — an agent or human identity. */
  submittedBy: string
}

/** The live state of one stage inside a project. */
export interface StageSnapshot {
  /** Opaque stage id. */
  id: StageId
  /** Human-readable stage title. */
  title: string
  /** Current lifecycle state. */
  state: StageState
  /** Failing submissions so far in the current run. */
  attempts: number
  /** The inner-loop ceiling. */
  maxRetries: number
  /** Verifier kinds bound to the stage. */
  verifiers: string[]
  /** The bound gate, when one exists. */
  gate?: GateId
  /** Latest verification reports, present after at least one submission. */
  reports?: VerificationReport[]
  /** The bound gate's latest decision; `pending` while undecided, `none` without a gate. */
  gateStatus?: 'none' | 'pending' | 'approved' | 'rejected'
  /** The escalation package, present while `escalated`. */
  escalation?: EscalationPackage
  /** A human rework instruction, present after an escalation resolution. */
  instruction?: string
}

/**
 * The per-project audit package (§5.4): the complete evidence chain of one
 * project — every stage's machine state plus the full request-and-decision
 * history of its bound gate — assembled for export, review, or archival.
 */
export interface AuditPackage {
  /** The exported project id. */
  projectId: ProjectId
  /** The project template name. */
  template: string
  /** Epoch milliseconds when the package was assembled. */
  exportedAt: number
  /** One record per stage, in template order. */
  stages: AuditStageRecord[]
}

/** One stage's record inside an {@link AuditPackage}. */
export interface AuditStageRecord {
  /** The template stage id. */
  stageId: StageId
  /** Human-readable stage title. */
  title: string
  /** Current lifecycle state. */
  state: StageState
  /** Failing submissions so far in the current run. */
  attempts: number
  /** The inner-loop ceiling. */
  maxRetries: number
  /** Verifier kinds bound to the stage. */
  verifiers: string[]
  /** The bound gate, when one exists. */
  gate?: GateId
  /** Latest verification reports, present after at least one submission. */
  reports?: VerificationReport[]
  /** The escalation package, present while `escalated`. */
  escalation?: EscalationPackage
  /** A human rework instruction, present after an escalation resolution. */
  instruction?: string
  /** The bound gate's full request history with decisions; empty without a gate. */
  gateRequests: GateRequest[]
}

/**
 * The escalation package (§4.2): task context, the last artifact, the
 * verification evidence, a failure summary, and candidate next actions.
 */
export interface EscalationPackage {
  /** The escalated stage. */
  stageId: StageId
  /** Why the work escalated — inner loop exhausted or a verifier unavailable. */
  reason: string
  /** The task context: what the stage was producing. */
  context: string
  /** The last submitted artifact text. */
  artifact: string
  /** The verification evidence backing the escalation. */
  reports: VerificationReport[]
  /** One-line failure summary for the supervisor. */
  failureSummary: string
  /** Candidate next actions for the supervisor to choose from. */
  options: string[]
}

/** One live project: its template, stage snapshots, and gate request links. */
export interface ProjectSnapshot {
  /** Opaque project id. */
  id: ProjectId
  /** The template the project was instantiated from. */
  template: string
  /** Stage snapshots in dependency order. */
  stages: StageSnapshot[]
  /** Gate ids this project has requested through the orchestrator. */
  requestedGates: GateId[]
  /** Human instructions from escalation resolutions, latest first. */
  instructions: { stageId: StageId; instruction: string }[]
}

/** Error thrown when a stage transition is not allowed from its state. */
export class StageTransitionError extends Error {
  /** Stable machine-readable error code. */
  readonly code = 'IA_ORCHESTRATOR_BAD_TRANSITION' as const

  /**
   * Construct the error describing the rejected transition.
   * @param stageId - the stage whose state rejected the transition.
   * @param state - the stage's current state.
   * @param action - the attempted transition.
   */
  constructor(stageId: StageId, state: StageState, action: string) {
    super(`cannot ${action} stage ${JSON.stringify(String(stageId))} while it is ${state}`)
    this.name = 'StageTransitionError'
  }
}

/** Error thrown when referencing an unknown project or stage. */
export class UnknownStageError extends Error {
  /** Stable machine-readable error code. */
  readonly code = 'IA_ORCHESTRATOR_UNKNOWN' as const

  /**
   * Construct the error naming the missing project or stage.
   * @param projectId - the project id.
   * @param stageId - the stage id, when the project existed but not the stage.
   */
  constructor(projectId: ProjectId, stageId?: StageId) {
    super(stageId === undefined
      ? `unknown project ${JSON.stringify(String(projectId))}`
      : `unknown stage ${JSON.stringify(String(stageId))} in project ${String(projectId)}`)
    this.name = 'UnknownStageError'
  }
}
