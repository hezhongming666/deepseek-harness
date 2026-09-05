/**
 * Wire-boundary validators for the Openness bridge verify protocol. The
 * bridge is an external process, so every response field is validated here
 * before it becomes adjudication evidence; a malformed response routes as an
 * unavailable verdict, never as a passing report.
 * @module @deepseek-ai/dsh-ia-verifier-openness/wire
 */

/** The run statuses the bridge can return. */
export type BridgeRunStatus = 'success' | 'diverged' | 'infrastructure' | 'killed'

/** One per-message severity the bridge reports; absent for older bridges. */
export type CompileMessageState = 'error' | 'warning' | 'info'

/** The validated `result` object of a successful verify run. */
export interface TiaCompileResult {
  /** The TIA compiler's error count. */
  compileErrors: number
  /** The TIA compiler's warning count. */
  compileWarnings: number
  /** The compile wall time in milliseconds. */
  compileMs: number
  /** The flattened compiler messages, errors and warnings included. */
  compileMessages: string[]
  /** Per-message severity, aligned with {@link compileMessages}; absent for older bridges. */
  compileMessageStates?: CompileMessageState[]
  /** The block the source was imported as, when the bridge reports it. */
  blockName?: string
}

/** The validated fields of one `POST /run` verify response. */
export interface TiaCompileRunResponse {
  /** The run id echoed from the request. */
  runId: string
  /** The bridge's run status. */
  status: BridgeRunStatus
  /** The compile result, present exactly when the status is `success`. */
  result?: TiaCompileResult
  /** The bridge's failure description, present for non-success statuses. */
  error?: string
}

const RUN_STATUSES: readonly string[] = ['success', 'diverged', 'infrastructure', 'killed']
const MESSAGE_STATES: readonly string[] = ['error', 'warning', 'info']

/** Guard for plain JSON records (bridge bodies arrive via `JSON.parse`). */
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

/** Read one non-negative integer count field. */
function count(record: { [key: string]: unknown }, field: string, subject: string): number {
  const value = record[field]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${subject} field ${JSON.stringify(field)} must be a non-negative integer`)
  }
  return value
}

/** Validate the compile `result` object of a successful verify run. */
function parseCompileResult(value: unknown, subject: string): TiaCompileResult {
  if (!isRecord(value)) throw new TypeError(`${subject} field "result" must be an object`)
  const compileErrors = count(value, 'compileErrors', subject)
  const compileWarnings = count(value, 'compileWarnings', subject)
  const compileMs = count(value, 'compileMs', subject)
  const messagesValue = value['compileMessages']
  if (!Array.isArray(messagesValue)
    || messagesValue.some((message: unknown) => typeof message !== 'string' || message.trim().length === 0)) {
    throw new TypeError(`${subject} field "compileMessages" must be an array of non-empty strings`)
  }
  const compileMessages = messagesValue as string[]
  const statesValue = value['compileMessageStates']
  if (statesValue !== undefined && statesValue !== null) {
    if (!Array.isArray(statesValue) || statesValue.length !== compileMessages.length
      || statesValue.some((state: unknown) => typeof state !== 'string' || !MESSAGE_STATES.includes(state))) {
      throw new TypeError(
        `${subject} field "compileMessageStates" must align with "compileMessages" and hold only ${MESSAGE_STATES.join(', ')}`,
      )
    }
  }
  const blockName = optionalText(value, 'blockName', subject)
  return {
    compileErrors,
    compileWarnings,
    compileMs,
    compileMessages,
    ...statesValue === undefined || statesValue === null
      ? {}
      : { compileMessageStates: statesValue as CompileMessageState[] },
    ...blockName === undefined ? {} : { blockName },
  }
}

/**
 * Validate one `POST /run` verify response body.
 * @param value - the parsed JSON body.
 * @returns the validated run outcome fields.
 */
export function parseTiaCompileRunResponse(value: unknown): TiaCompileRunResponse {
  const subject = 'openness bridge /run verify response'
  if (!isRecord(value)) throw new TypeError(`${subject} must be an object`)
  const runId = optionalText(value, 'runId', subject)
  if (runId === undefined) throw new TypeError(`${subject} field "runId" must be a non-empty string`)
  const status = value['status']
  if (typeof status !== 'string' || !RUN_STATUSES.includes(status)) {
    throw new TypeError(`${subject} field "status" must be one of ${RUN_STATUSES.join(', ')}`)
  }
  const resultValue = value['result']
  if (status === 'success') {
    if (resultValue === undefined || resultValue === null) {
      throw new TypeError(`${subject} must carry a "result" object for status "success"`)
    }
  } else if (resultValue !== undefined && resultValue !== null) {
    throw new TypeError(`${subject} must not carry a "result" object for status ${JSON.stringify(status)}`)
  }
  const error = optionalText(value, 'error', subject)
  if (status !== 'success' && error === undefined) {
    throw new TypeError(`${subject} must carry a non-empty "error" for status ${JSON.stringify(status)}`)
  }
  return {
    runId,
    status: status as BridgeRunStatus,
    ...status === 'success' ? { result: parseCompileResult(resultValue, subject) } : {},
    ...error === undefined ? {} : { error },
  }
}
