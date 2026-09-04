/**
 * Wire-boundary validators for the Openness bridge protocol. The bridge is an
 * external process, so every response field is validated here before it
 * reaches the adapter seam; malformed responses throw `TypeError` and route
 * as infrastructure failures.
 * @module @deepseek-ai/dsh-provider-openness/wire
 */

import type { AdapterEnvironment, ValidationOutcome } from '@deepseek-ai/dsh-spec-loop'
import type {
  BridgeHealthResponse,
  BridgeRunResponse,
} from './types.ts'

/** Guard for plain JSON records (the bridge bodies arrive via `JSON.parse`). */
function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read one optional non-empty string field; JSON null counts as absent. */
function optionalText(record: { [key: string]: unknown }, field: string, subject: string): string | undefined {
  const value = record[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${subject} field ${JSON.stringify(field)} must be a non-empty string`)
  }
  return value
}

/** Validate one optional environment version tuple; JSON null counts as absent. */
function parseEnvironment(value: unknown, subject: string): AdapterEnvironment | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new TypeError(`${subject} field environment must be an object`)
  const environment: AdapterEnvironment = {}
  const softwareVersion = optionalText(value, 'softwareVersion', subject)
  if (softwareVersion !== undefined) environment.softwareVersion = softwareVersion
  const solverVersion = optionalText(value, 'solverVersion', subject)
  if (solverVersion !== undefined) environment.solverVersion = solverVersion
  const licenseServerVersion = optionalText(value, 'licenseServerVersion', subject)
  if (licenseServerVersion !== undefined) environment.licenseServerVersion = licenseServerVersion
  const osKernel = optionalText(value, 'osKernel', subject)
  if (osKernel !== undefined) environment.osKernel = osKernel
  return environment
}

const RUN_STATUSES: readonly string[] = ['success', 'diverged', 'infrastructure', 'killed']

/**
 * Validate one `POST /run` response body.
 * @param value - the parsed JSON body.
 * @returns the validated run outcome fields.
 */
export function parseRunResponse(value: unknown): BridgeRunResponse {
  const subject = 'openness bridge /run response'
  if (!isRecord(value)) throw new TypeError(`${subject} must be an object`)
  const runId = optionalText(value, 'runId', subject)
  if (runId === undefined) throw new TypeError(`${subject} field "runId" must be a non-empty string`)
  const status = value['status']
  if (typeof status !== 'string' || !RUN_STATUSES.includes(status)) {
    throw new TypeError(`${subject} field "status" must be one of ${RUN_STATUSES.join(', ')}`)
  }
  const result = value['result']
  if (status === 'success') {
    if (!isRecord(result)) throw new TypeError(`${subject} must carry a result object for status "success"`)
  } else if (result !== undefined) {
    throw new TypeError(`${subject} must not carry a result for status ${JSON.stringify(status)}`)
  }
  const licenseMs = value['licenseMs']
  if (licenseMs !== undefined && (typeof licenseMs !== 'number' || !Number.isFinite(licenseMs) || licenseMs < 0)) {
    throw new TypeError(`${subject} field "licenseMs" must be a non-negative finite number`)
  }
  const error = optionalText(value, 'error', subject)
  if (status !== 'success' && error === undefined) {
    throw new TypeError(`${subject} must carry a non-empty "error" for status ${JSON.stringify(status)}`)
  }
  const environment = parseEnvironment(value['environment'], subject)
  return {
    runId,
    status: status as BridgeRunResponse['status'],
    ...result === undefined ? {} : { result },
    ...licenseMs === undefined ? {} : { licenseMs },
    ...error === undefined ? {} : { error },
    ...environment === undefined ? {} : { environment },
  }
}

/**
 * Validate one `POST /validate` response body.
 * @param value - the parsed JSON body.
 * @returns the validated S1-gate outcome.
 */
export function parseValidateResponse(value: unknown): ValidationOutcome {
  const subject = 'openness bridge /validate response'
  if (!isRecord(value)) throw new TypeError(`${subject} must be an object`)
  const ok = value['ok']
  if (typeof ok !== 'boolean') throw new TypeError(`${subject} field "ok" must be a boolean`)
  const reasonsValue = value['reasons']
  if (!Array.isArray(reasonsValue)
    || reasonsValue.some((reason: unknown) => typeof reason !== 'string' || reason.trim().length === 0)) {
    throw new TypeError(`${subject} field "reasons" must be an array of non-empty strings`)
  }
  if (!ok && reasonsValue.length === 0) {
    throw new TypeError(`${subject} must carry at least one reason when "ok" is false`)
  }
  // The guard above proved every element a non-empty string.
  const reasons = reasonsValue as string[]
  return { ok, reasons }
}

/**
 * Validate one `GET /health` response body.
 * @param value - the parsed JSON body.
 * @returns the validated health record.
 */
export function parseHealthResponse(value: unknown): BridgeHealthResponse {
  const subject = 'openness bridge /health response'
  if (!isRecord(value)) throw new TypeError(`${subject} must be an object`)
  const ok = value['ok']
  if (typeof ok !== 'boolean') throw new TypeError(`${subject} field "ok" must be a boolean`)
  const environment = parseEnvironment(value['environment'], subject)
  const error = optionalText(value, 'error', subject)
  if (!ok && error === undefined) {
    throw new TypeError(`${subject} must carry a non-empty "error" when "ok" is false`)
  }
  return {
    ok,
    ...environment === undefined ? {} : { environment },
    ...error === undefined ? {} : { error },
  }
}
