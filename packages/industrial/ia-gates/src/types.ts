/**
 * Shared vocabulary of the gate layer: automation levels, gate definitions,
 * requests, and decisions.
 * @module @deepseek-ai/dsh-ia-gates
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque id of one gate. */
export type GateId = Branded<'GateId'>

/**
 * Brand a string as a {@link GateId}.
 * @param value - the opaque gate identifier.
 * @returns the same string, branded; no validation is performed.
 */
export function GateId(value: string): GateId {
  return value as GateId
}

/**
 * Automation level of one deployment: what the agent may do before a human
 * decides. A0 assists only, A1 generates with automatic inner-loop repair but
 * stops at gates, A2 releases rule-bound gates automatically, A3 adds
 * automatic operation-loop proposals. Levels never relax always-human gates.
 */
export type AutomationLevel = 'A0' | 'A1' | 'A2' | 'A3'

/** Closed set of automation levels, as a runtime value for input validation. */
export const AUTOMATION_LEVELS: readonly AutomationLevel[] = ['A0', 'A1', 'A2', 'A3']

/** One gate definition. */
export interface GateDefinition {
  /** Opaque gate id. */
  id: GateId
  /** Human-readable gate title. */
  title: string
  /** What this gate decides and why a human owns it. */
  description: string
  /**
   * Mandatory gates ship with the service and cannot be removed or
   * re-registered; project gates are added by the orchestrator.
   */
  mandatory: boolean
  /**
   * Dangerous gates stay human at every automation level: no auto-release
   * rule may ever be registered for them.
   */
  alwaysHuman: boolean
}

/** Input for registering one project gate: everything but the forced `mandatory` flag. */
export type GateRegistration = Omit<GateDefinition, 'mandatory'>

/** Deterministic rule that may release a gate at automation level A2 or A3. */
export type AutoReleaseRule = (context: GateRequestContext) => boolean

/** The context a gate decision is asked about. */
export interface GateRequestContext {
  /** Why the gate is being requested now — the stage transition. */
  reason: string
  /** Bounded structured evidence backing the request, e.g. verifier reports. */
  evidence: string[]
  /** Optional free-form project context summary. */
  context?: string
}

/** One gate request with its optional decision. */
export interface GateRequest {
  /** Service-issued ordinal id of the request, unique per gate. */
  id: number
  /** The requested gate. */
  gateId: GateId
  /** Who asked — an agent or human identity string. */
  requestedBy: string
  /** The decision context. */
  context: GateRequestContext
  /** Epoch milliseconds when the request was made. */
  requestedAt: number
  /** The decision, present once decided. */
  decision?: GateDecision
}

/** One gate decision: who decided, what, and why. */
export interface GateDecision {
  /** `'approved'` releases the gate; `'rejected'` sends the work back. */
  outcome: 'approved' | 'rejected'
  /** Who decided — a human identity, the approval channel, or a rule id. */
  decider: string
  /** The decision rationale, kept for the audit trail. */
  rationale: string
  /** Epoch milliseconds when the decision was made. */
  decidedAt: number
}

/** Outcome of asking the human channel for one pending gate decision. */
export type HumanDecisionOutcome =
  /** The human approved; the request now carries the decision. */
  | 'approved'
  /** The human rejected; the request now carries the decision. */
  | 'rejected'
  /** The human channel is absent or did not answer; the request stays pending. */
  | 'pending'

/** Error thrown when referencing an unregistered gate. */
export class UnknownGateError extends Error {
  /** Stable machine-readable error code. */
  readonly code = 'IA_GATES_UNKNOWN_GATE' as const

  /**
   * Construct the error naming the missing gate.
   * @param id - the unresolved gate id.
   */
  constructor(id: GateId) {
    super(`unknown gate ${JSON.stringify(String(id))}`)
    this.name = 'UnknownGateError'
  }
}

/** Error thrown when re-registering an existing gate id. */
export class DuplicateGateError extends Error {
  /** Stable machine-readable error code. */
  readonly code = 'IA_GATES_DUPLICATE_GATE' as const

  /**
   * Construct the error naming the duplicate gate.
   * @param id - the already-registered gate id.
   */
  constructor(id: GateId) {
    super(`gate ${JSON.stringify(String(id))} is already registered`)
    this.name = 'DuplicateGateError'
  }
}

/** Error thrown when an auto-release rule targets an always-human gate. */
export class AlwaysHumanGateError extends Error {
  /** Stable machine-readable error code. */
  readonly code = 'IA_GATES_ALWAYS_HUMAN' as const

  /**
   * Construct the error naming the always-human gate.
   * @param id - the gate that must stay human.
   */
  constructor(id: GateId) {
    super(`gate ${JSON.stringify(String(id))} stays human at every automation level — no auto-release rule may target it`)
    this.name = 'AlwaysHumanGateError'
  }
}
