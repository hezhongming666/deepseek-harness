/**
 * Snapshot persistence for the orchestrator: every project's stage machine —
 * states, attempts, latest reports, escalations, human instructions, and the
 * requested gate roster — plus the project-id ordinal, as one versioned JSON
 * snapshot under the configured `dataDir`. Templates are code and are never
 * persisted; restore re-binds each stage to its template node.
 * @module @deepseek-ai/dsh-ia-orchestrator/persistence
 */

import { join } from 'node:path'
import { readJsonSnapshot, writeJsonSnapshot } from '@deepseek-ai/dsh-atomic-write'
import type { VerificationReport } from '@deepseek-ai/dsh-ia-verifier'
import { ProjectId, StageId } from './types.ts'
import type { EscalationPackage, StageState } from './types.ts'

/** The snapshot file name under `dataDir`. */
export const ORCHESTRATOR_SNAPSHOT_NAME = 'ia-orchestrator.json'
/** The snapshot format version; bump only with a coordinated reader change. */
export const ORCHESTRATOR_SNAPSHOT_VERSION = 1

const STAGE_STATES: readonly string[] = ['pending', 'running', 'repair', 'gated', 'passed', 'escalated']
const SEVERITIES: readonly string[] = ['error', 'warning']

/** One stage's persisted machine state, re-bound to its template node on restore. */
export interface OrchestratorStageState {
  /** The template stage id this record binds to. */
  stageId: StageId
  /** Current lifecycle state. */
  state: StageState
  /** Failing submissions so far in the current run. */
  attempts: number
  /** Latest verification reports, present after at least one submission. */
  reports?: VerificationReport[]
  /** The escalation package, present while `escalated`. */
  escalation?: EscalationPackage
  /** The human rework instruction, present after an escalation resolution. */
  instruction?: string
}

/** One project's persisted machine state. */
export interface OrchestratorProjectState {
  /** Opaque project id. */
  id: ProjectId
  /** Template name; must exist at restore time. */
  template: string
  /** Stage records in dependency order. */
  stages: OrchestratorStageState[]
  /** Gate ids requested through the orchestrator. */
  requestedGates: string[]
  /** Escalation-resolution instructions, latest first. */
  instructions: { stageId: StageId; instruction: string }[]
}

/** The persisted orchestrator state. */
export interface OrchestratorSnapshotState {
  /** The highest issued project ordinal. */
  ordinal: number
  /** Every project, in creation order. */
  projects: OrchestratorProjectState[]
}

/** The snapshot path for one data directory.
 * @param dataDir - the configured data directory.
 * @returns the snapshot file path.
 */
export function orchestratorSnapshotPath(dataDir: string): string {
  return join(dataDir, ORCHESTRATOR_SNAPSHOT_NAME)
}

/** Guard for plain JSON records (snapshot bodies arrive via `JSON.parse`). */
function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read one required non-empty string field. */
function requiredText(record: { [key: string]: unknown }, field: string, subject: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${subject} field ${JSON.stringify(field)} must be a non-empty string`)
  }
  return value
}

/** Read one optional string field; JSON null counts as absent. */
function optionalText(record: { [key: string]: unknown }, field: string, subject: string): string | undefined {
  const value = record[field]
  if (value === undefined || value === null) return undefined
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

/** Validate one restored verification report. */
function validateReport(value: unknown, subject: string): VerificationReport {
  if (!isRecord(value)) throw new Error(`${subject} report must be an object`)
  const diagnostics = value['diagnostics']
  if (!Array.isArray(diagnostics)) throw new Error(`${subject} report diagnostics must be an array`)
  const parsedDiagnostics = diagnostics.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`${subject} diagnostic #${index} must be an object`)
    const severity = entry['severity']
    if (typeof severity !== 'string' || !SEVERITIES.includes(severity)) {
      throw new Error(`${subject} diagnostic #${index} severity must be "error" or "warning"`)
    }
    const position = entry['position']
    const parsedPosition = position === undefined || position === null
      ? undefined
      : (() => {
        if (!isRecord(position)) throw new Error(`${subject} diagnostic #${index} position must be an object`)
        return {
          line: nonNegativeNumber(position, 'line', `${subject} diagnostic #${index} position`),
          column: nonNegativeNumber(position, 'column', `${subject} diagnostic #${index} position`),
        }
      })()
    return {
      code: requiredText(entry, 'code', `${subject} diagnostic #${index}`),
      message: requiredText(entry, 'message', `${subject} diagnostic #${index}`),
      severity: severity as 'error' | 'warning',
      ...(parsedPosition === undefined ? {} : { position: parsedPosition }),
    }
  })
  const evidence = value['evidence']
  if (!Array.isArray(evidence)) throw new Error(`${subject} report evidence must be an array`)
  const parsedEvidence = evidence.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`${subject} evidence #${index} must be an object`)
    return {
      kind: requiredText(entry, 'kind', `${subject} evidence #${index}`),
      summary: requiredText(entry, 'summary', `${subject} evidence #${index}`),
      ...(entry['detail'] === undefined || entry['detail'] === null
        ? {}
        : { detail: requiredText(entry, 'detail', `${subject} evidence #${index}`) }),
    }
  })
  return {
    kind: requiredText(value, 'kind', subject),
    pass: value['pass'] === true,
    diagnostics: parsedDiagnostics,
    evidence: parsedEvidence,
  }
}

/** Validate one restored escalation package. */
function validateEscalation(value: unknown, subject: string): EscalationPackage {
  if (!isRecord(value)) throw new Error(`${subject} escalation must be an object`)
  const reportsValue = value['reports']
  if (!Array.isArray(reportsValue)) throw new Error(`${subject} escalation reports must be an array`)
  const reports: VerificationReport[] = reportsValue.map(
    (entry, index) => validateReport(entry, `${subject} report #${index}`),
  )
  const options = value['options']
  if (!Array.isArray(options) || options.some((option: unknown) => typeof option !== 'string' || option.trim().length === 0)) {
    throw new Error(`${subject} escalation options must be an array of non-empty strings`)
  }
  return {
    stageId: StageId(requiredText(value, 'stageId', subject)),
    reason: requiredText(value, 'reason', subject),
    context: requiredText(value, 'context', subject),
    artifact: requiredText(value, 'artifact', subject),
    reports,
    failureSummary: requiredText(value, 'failureSummary', subject),
    options: options as string[],
  }
}

/** Validate one restored stage record. */
function validateStage(value: unknown, subject: string): OrchestratorStageState {
  if (!isRecord(value)) throw new Error(`${subject} stage must be an object`)
  const state = value['state']
  if (typeof state !== 'string' || !STAGE_STATES.includes(state)) {
    throw new Error(`${subject} stage state must be one of ${STAGE_STATES.join(', ')}`)
  }
  const reports = value['reports']
  const escalation = value['escalation']
  const instruction = optionalText(value, 'instruction', subject)
  const parsedReports: VerificationReport[] | undefined = reports === undefined || reports === null
    ? undefined
    : (reports as unknown[]).map((entry, index) => validateReport(entry, `${subject} report #${index}`))
  return {
    stageId: StageId(requiredText(value, 'stageId', subject)),
    state: state as StageState,
    attempts: nonNegativeNumber(value, 'attempts', subject),
    ...(parsedReports === undefined ? {} : { reports: parsedReports }),
    ...(escalation === undefined || escalation === null
      ? {}
      : { escalation: validateEscalation(escalation, subject) }),
    ...(instruction === undefined ? {} : { instruction }),
  }
}

/** Validate one restored project record. */
function validateProject(value: unknown, subject: string): OrchestratorProjectState {
  if (!isRecord(value)) throw new Error(`${subject} project must be an object`)
  const stages = value['stages']
  if (!Array.isArray(stages)) throw new Error(`${subject} project stages must be an array`)
  const requestedGates = value['requestedGates']
  if (!Array.isArray(requestedGates)
    || requestedGates.some((gate: unknown) => typeof gate !== 'string' || gate.trim().length === 0)) {
    throw new Error(`${subject} project requestedGates must be an array of non-empty strings`)
  }
  const instructions = value['instructions']
  if (!Array.isArray(instructions)) throw new Error(`${subject} project instructions must be an array`)
  const parsedInstructions = instructions.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`${subject} instruction #${index} must be an object`)
    return {
      stageId: StageId(requiredText(entry, 'stageId', `${subject} instruction #${index}`)),
      instruction: requiredText(entry, 'instruction', `${subject} instruction #${index}`),
    }
  })
  return {
    id: ProjectId(requiredText(value, 'id', subject)),
    template: requiredText(value, 'template', subject),
    stages: stages.map((entry, index) => validateStage(entry, `${subject} stage #${index}`)),
    requestedGates: requestedGates as string[],
    instructions: parsedInstructions,
  }
}

/**
 * Load the orchestrator snapshot: `undefined` for a fresh store, or the
 * validated state. Corrupt, wrong-version, or malformed snapshots throw and
 * name the file — a store never silently degrades.
 * @param dataDir - the configured data directory.
 * @returns the restored state, or `undefined` when no snapshot exists.
 */
export function loadOrchestratorSnapshot(dataDir: string): OrchestratorSnapshotState | undefined {
  const file = orchestratorSnapshotPath(dataDir)
  const raw = readJsonSnapshot(file, ORCHESTRATOR_SNAPSHOT_VERSION)
  if (raw === undefined) return undefined
  const subject = `iaOrchestrator snapshot ${file}`
  if (!isRecord(raw)) throw new Error(`${subject} state must be an object`)
  const ordinal = nonNegativeNumber(raw, 'ordinal', subject)
  const projects = raw['projects']
  if (!Array.isArray(projects)) throw new Error(`${subject} field "projects" must be an array`)
  return {
    ordinal,
    projects: projects.map((entry, index) => validateProject(entry, `${subject} project #${index}`)),
  }
}

/**
 * Persist the orchestrator state as one atomic snapshot.
 * @param dataDir - the configured data directory.
 * @param state - the complete current state.
 */
export function saveOrchestratorSnapshot(dataDir: string, state: OrchestratorSnapshotState): void {
  writeJsonSnapshot(orchestratorSnapshotPath(dataDir), ORCHESTRATOR_SNAPSHOT_VERSION, state)
}
