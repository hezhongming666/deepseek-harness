/**
 * Snapshot persistence for the gate engine: the state that must survive a
 * restart — every request with its decision and the request ordinal — as one
 * versioned JSON snapshot under the configured `dataDir`. Gate definitions
 * and auto-release rules are registration effects (code) and are never
 * persisted; their owners re-register them at boot.
 * @module @deepseek-ai/dsh-ia-gates/persistence
 */

import { join } from 'node:path'
import { readJsonSnapshot, writeJsonSnapshot } from '@deepseek-ai/dsh-atomic-write'
import { GateId } from './types.ts'
import type { GateDecision, GateRequest } from './types.ts'

/** The snapshot file name under `dataDir`. */
export const GATES_SNAPSHOT_NAME = 'ia-gates.json'
/** The snapshot format version; bump only with a coordinated reader change. */
export const GATES_SNAPSHOT_VERSION = 1

/** The persisted gate-engine state. */
export interface GatesSnapshotState {
  /** The highest issued request ordinal. */
  ordinal: number
  /** Every request across gates, in recording order. */
  requests: GateRequest[]
}

/** The snapshot path for one data directory.
 * @param dataDir - the configured data directory.
 * @returns the snapshot file path.
 */
export function gatesSnapshotPath(dataDir: string): string {
  return join(dataDir, GATES_SNAPSHOT_NAME)
}

/** Guard for plain JSON records (snapshot bodies arrive via `JSON.parse`). */
function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read one optional non-empty string field. */
function requiredText(record: { [key: string]: unknown }, field: string, subject: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${subject} field ${JSON.stringify(field)} must be a non-empty string`)
  }
  return value
}

/** Read one non-negative finite number field. */
function nonNegativeNumber(record: { [key: string]: unknown }, field: string, subject: string): number {
  const value = record[field]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${subject} field ${JSON.stringify(field)} must be a non-negative number`)
  }
  return value
}

/** Validate one restored gate decision. */
function validateDecision(value: unknown, subject: string): GateDecision {
  if (!isRecord(value)) throw new Error(`${subject} decision must be an object`)
  const outcome = value['outcome']
  if (outcome !== 'approved' && outcome !== 'rejected') {
    throw new Error(`${subject} decision outcome must be "approved" or "rejected"`)
  }
  return {
    outcome,
    decider: requiredText(value, 'decider', subject),
    rationale: requiredText(value, 'rationale', subject),
    decidedAt: nonNegativeNumber(value, 'decidedAt', subject),
  }
}

/** Validate one restored gate request. */
function validateRequest(value: unknown, subject: string): GateRequest {
  if (!isRecord(value)) throw new Error(`${subject} request must be an object`)
  const context = value['context']
  if (!isRecord(context)) throw new Error(`${subject} request context must be an object`)
  const evidence = context['evidence']
  if (!Array.isArray(evidence) || evidence.some((item: unknown) => typeof item !== 'string')) {
    throw new Error(`${subject} request context evidence must be an array of strings`)
  }
  const decision = value['decision']
  return {
    id: nonNegativeNumber(value, 'id', subject),
    gateId: GateId(requiredText(value, 'gateId', subject)),
    requestedBy: requiredText(value, 'requestedBy', subject),
    context: {
      reason: requiredText(context, 'reason', subject),
      evidence: evidence as string[],
      ...(context['context'] === undefined ? {} : { context: requiredText(context, 'context', subject) }),
    },
    requestedAt: nonNegativeNumber(value, 'requestedAt', subject),
    ...(decision === undefined ? {} : { decision: validateDecision(decision, subject) }),
  }
}

/**
 * Load the gate-engine snapshot: `undefined` for a fresh store, or the
 * validated state. Corrupt, wrong-version, or malformed snapshots throw and
 * name the file — a store never silently degrades.
 * @param dataDir - the configured data directory.
 * @returns the restored state, or `undefined` when no snapshot exists.
 */
export function loadGatesSnapshot(dataDir: string): GatesSnapshotState | undefined {
  const file = gatesSnapshotPath(dataDir)
  const raw = readJsonSnapshot(file, GATES_SNAPSHOT_VERSION)
  if (raw === undefined) return undefined
  const subject = `iaGates snapshot ${file}`
  if (!isRecord(raw)) throw new Error(`${subject} state must be an object`)
  const ordinal = nonNegativeNumber(raw, 'ordinal', subject)
  const requestsValue = raw['requests']
  if (!Array.isArray(requestsValue)) throw new Error(`${subject} field "requests" must be an array`)
  const requests = requestsValue.map((value, index) => validateRequest(value, `${subject} request #${index}`))
  return { ordinal, requests }
}

/**
 * Persist the gate-engine state as one atomic snapshot.
 * @param dataDir - the configured data directory.
 * @param state - the complete current state.
 */
export function saveGatesSnapshot(dataDir: string, state: GatesSnapshotState): void {
  writeJsonSnapshot(gatesSnapshotPath(dataDir), GATES_SNAPSHOT_VERSION, state)
}
