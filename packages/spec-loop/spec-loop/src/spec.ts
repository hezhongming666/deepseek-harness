/**
 * Spec validation: the wire-boundary narrowing from model-supplied JSON to the
 * typed {@link SpecLoopSpec} the engine trusts. Misconfiguration fails loud
 * with a machine-routable {@link SpecLoopError}.
 * @module @deepseek-ai/dsh-spec-loop
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type {
  Assertion,
  ParameterBounds,
  ParameterEnvelope,
  RepairPolicy,
  SpecBudgets,
  SpecLoopSpec,
} from './types.ts'

/** Machine-routable spec-loop failure codes. */
export type SpecLoopErrorCode = 'INVALID_SPEC'

/**
 * Typed error for spec-loop failures. Extends {@link HarnessError}, so the
 * `code` is machine-routable taxonomy.
 */
export class SpecLoopError extends HarnessError {
  constructor(message: string, code: SpecLoopErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'SpecLoopError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param value - any value; @returns the non-empty trimmed string, or undefined. */
function normalizedText(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  return value.trim()
}

/** @param value - any value; @returns the finite number, or undefined. */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** @param value - any value; @returns the positive safe integer, or undefined. */
function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : undefined
}

/** @param value - any value; @returns the non-negative finite number, or undefined. */
function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Read one assertion predicate and threshold pair. */
function readAssertion(raw: unknown, path: string): Assertion | never {
  const fail = (reason: string): never => {
    throw new SpecLoopError(`spec assertion at ${path}: ${reason}`, 'INVALID_SPEC')
  }
  if (!isRecord(raw)) return fail('must be an object')
  const id = normalizedText(raw['id'])
  if (id === undefined) return fail('id must be a non-empty string')
  const metricPath = normalizedText(raw['path'])
  if (metricPath === undefined) return fail('path must be a non-empty string')
  const predicate = raw['predicate']
  if (predicate !== 'lte' && predicate !== 'gte' && predicate !== 'between') {
    return fail(`predicate must be lte, gte, or between (got ${JSON.stringify(predicate)})`)
  }
  if (predicate === 'between') {
    const target = raw['target']
    if (!Array.isArray(target) || target.length !== 2) return fail('between target must be a [min, max] pair')
    const min = finiteNumber(target[0])
    const max = finiteNumber(target[1])
    if (min === undefined || max === undefined) return fail('between target entries must be finite numbers')
    if (min > max) return fail('between target min must not exceed max')
    return { id, path: metricPath, predicate, target: [min, max] }
  }
  const target = finiteNumber(raw['target'])
  if (target === undefined) return fail('target must be a finite number')
  return { id, path: metricPath, predicate, target }
}

/** Read one parameter-bounds pair. */
function readBounds(raw: unknown, path: string): ParameterBounds | never {
  const fail = (reason: string): never => {
    throw new SpecLoopError(`spec envelope bound at ${path}: ${reason}`, 'INVALID_SPEC')
  }
  if (!isRecord(raw)) return fail('must be an object')
  const min = finiteNumber(raw['min'])
  const max = finiteNumber(raw['max'])
  if (min === undefined || max === undefined) return fail('min and max must be finite numbers')
  if (min > max) return fail('min must not exceed max')
  return { min, max }
}

/**
 * Narrow and validate a model-supplied spec into the typed contract.
 * Rejects malformed, empty, or self-contradictory specs with a
 * {@link SpecLoopError}; the returned object is a fresh read-only view built
 * from the validated fields.
 * @param raw - the JSON value from the model-visible boundary.
 * @returns the validated spec.
 */
export function validateSpec(raw: unknown): SpecLoopSpec {
  const fail = (reason: string): never => {
    throw new SpecLoopError(`invalid spec: ${reason}`, 'INVALID_SPEC')
  }
  if (!isRecord(raw)) return fail('must be a JSON object')
  const id = normalizedText(raw['id'])
  if (id === undefined) return fail('id must be a non-empty string')

  const objectiveRaw = raw['objective']
  if (!isRecord(objectiveRaw)) return fail('objective must be an object')
  const objectivePath = normalizedText(objectiveRaw['path'])
  if (objectivePath === undefined) return fail('objective.path must be a non-empty string')
  const direction = objectiveRaw['direction']
  if (direction !== 'minimize' && direction !== 'maximize') {
    return fail(`objective.direction must be minimize or maximize (got ${JSON.stringify(direction)})`)
  }

  const assertionsRaw = raw['assertions']
  if (!Array.isArray(assertionsRaw) || assertionsRaw.length === 0) {
    return fail('assertions must be a non-empty array')
  }
  const assertions = assertionsRaw.map((assertion, index) => readAssertion(assertion, `assertions[${index}]`))

  const budgetsRaw = raw['budgets']
  if (!isRecord(budgetsRaw)) return fail('budgets must be an object')
  const maxIterations = positiveInteger(budgetsRaw['maxIterations'])
  if (maxIterations === undefined) return fail('budgets.maxIterations must be a positive safe integer')
  const budgets: SpecBudgets = { maxIterations }
  if (budgetsRaw['maxWallClockMs'] !== undefined) {
    const maxWallClockMs = positiveInteger(budgetsRaw['maxWallClockMs'])
    if (maxWallClockMs === undefined) return fail('budgets.maxWallClockMs must be a positive safe integer')
    budgets.maxWallClockMs = maxWallClockMs
  }
  if (budgetsRaw['maxTokens'] !== undefined) {
    const maxTokens = positiveInteger(budgetsRaw['maxTokens'])
    if (maxTokens === undefined) return fail('budgets.maxTokens must be a positive safe integer')
    budgets.maxTokens = maxTokens
  }

  const repairRaw = raw['repair']
  if (!isRecord(repairRaw)) return fail('repair must be an object')
  const margin = nonNegativeNumber(repairRaw['margin'])
  if (margin === undefined) return fail('repair.margin must be a non-negative finite number')
  const maxNoImprovement = positiveInteger(repairRaw['maxNoImprovement'])
  if (maxNoImprovement === undefined) return fail('repair.maxNoImprovement must be a positive safe integer')
  const repair: RepairPolicy = { margin, maxNoImprovement }
  if (repairRaw['maxConsecutiveInfrastructure'] !== undefined) {
    const maxConsecutiveInfrastructure = positiveInteger(repairRaw['maxConsecutiveInfrastructure'])
    if (maxConsecutiveInfrastructure === undefined) {
      return fail('repair.maxConsecutiveInfrastructure must be a positive safe integer')
    }
    repair.maxConsecutiveInfrastructure = maxConsecutiveInfrastructure
  }

  let envelope: ParameterEnvelope | undefined
  if (raw['envelope'] !== undefined) {
    const envelopeRaw = raw['envelope']
    if (!isRecord(envelopeRaw)) return fail('envelope must be an object')
    const boundsRaw = envelopeRaw['bounds']
    if (!isRecord(boundsRaw)) return fail('envelope.bounds must be an object')
    const bounds: { [path: string]: ParameterBounds } = {}
    for (const [path, value] of Object.entries(boundsRaw)) {
      if (path.trim().length === 0) return fail('envelope.bounds path must be non-empty')
      bounds[path] = readBounds(value, `envelope.bounds.${path}`)
    }
    envelope = { bounds }
  }

  let description: string | undefined
  if (raw['description'] !== undefined) {
    description = normalizedText(raw['description'])
    if (description === undefined) return fail('description must be a non-empty string when present')
  }

  return Object.freeze({
    id,
    objective: Object.freeze({ path: objectivePath, direction }),
    assertions: Object.freeze(assertions),
    budgets: Object.freeze(budgets),
    repair: Object.freeze(repair),
    ...envelope === undefined ? {} : { envelope: Object.freeze({ bounds: Object.freeze(envelope.bounds) }) },
    ...description === undefined ? {} : { description },
  })
}
