/**
 * TIA Portal Openness compile verifier: registers the `tia-compile` validator
 * kind into `ctx.iaVerifiers`. The kind adjudicates control-program artifacts
 * through a real vendor compile — it imports the submitted TIA SCL block into
 * the configured project through the Openness bridge's `/run` verify action
 * and compiles it, so the report reflects TIA Portal's own verdict, not a
 * model judgment. Fail-closed everywhere: an unreachable bridge, a timeout, a
 * failed import, or a malformed wire response all yield a failing report with
 * a machine-readable `tia-compile-unavailable` or `tia-compile-import-failed`
 * diagnostic. Misconfiguration (missing or non-HTTP `url`, invalid block
 * name) fails at load.
 * @module @deepseek-ai/dsh-ia-verifier-openness
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Diagnostic, VerificationInput, VerificationReport } from '@deepseek-ai/dsh-ia-verifier'
import { parseTiaCompileRunResponse } from './wire.ts'
import type { TiaCompileRunResponse } from './wire.ts'

/** Cordis plugin name. */
export const name = 'ia-verifier-openness'
/** The verifier registry this plugin extends. */
export const inject = ['iaVerifiers']

/** The validator kind this plugin registers. */
export const TIA_COMPILE_KIND = 'tia-compile' as const

/** Default block name the submitted source is imported as. */
const DEFAULT_BLOCK_NAME = 'IACheck'
/** Default per-request bridge timeout, matching the spec-loop provider. */
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000
/** Upper bound on diagnostics per report; further messages stay in evidence counts. */
const MAX_DIAGNOSTICS = 100
/** TIA identifier shape: letter or underscore, then letters, digits, underscores. */
const BLOCK_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

/**
 * Plugin configuration. `url` is required: it names the deployment-owned
 * Openness bridge serving the TIA project to compile against.
 */
export interface Config {
  /** Absolute http(s) URL of the running Openness bridge, e.g. `http://127.0.0.1:4281`. */
  url?: string
  /**
   * The TIA block name the submitted source defines and is imported as
   * (default `IACheck`). The source must declare a block with exactly this
   * name, or the import fails with "was not generated from the source".
   */
  blockName?: string
  /** Per-request bridge timeout in milliseconds (default 300000). */
  requestTimeoutMs?: number
}

/** Runtime configuration schema for the openness compile verifier. */
export const Config: z<Config> = z.object({
  url: z.string().default(''),
  blockName: z.string().default(DEFAULT_BLOCK_NAME),
  requestTimeoutMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_REQUEST_TIMEOUT_MS),
})

/** The semantically validated configuration the verifier runs against. */
export interface ResolvedConfig {
  /** Bridge origin without a trailing slash. */
  baseUrl: string
  /** The TIA block name the source is imported as. */
  blockName: string
  /** Per-request bridge timeout in milliseconds. */
  requestTimeoutMs: number
}

/**
 * Apply the semantic constraints the config schema cannot express: `url` must
 * be an absolute http(s) URL, `blockName` must be a TIA identifier, and the
 * timeout must be a positive safe integer.
 * @param config - the schema-validated config.
 * @returns the resolved configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const raw = (config.url ?? '').trim()
  if (raw.length === 0) {
    throw new TypeError('ia-verifier-openness requires the url of a running Openness bridge')
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new TypeError(`ia-verifier-openness url must be an absolute http(s) URL, got ${JSON.stringify(config.url)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`ia-verifier-openness url must be an absolute http(s) URL, got ${JSON.stringify(config.url)}`)
  }
  const blockName = config.blockName ?? DEFAULT_BLOCK_NAME
  if (!BLOCK_NAME_PATTERN.test(blockName)) {
    throw new TypeError(
      `ia-verifier-openness blockName must be a TIA identifier (letter or underscore, then letters, digits, underscores; at most 128 characters), got ${JSON.stringify(blockName)}`,
    )
  }
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw new TypeError('ia-verifier-openness requestTimeoutMs must be a positive safe integer')
  }
  return { baseUrl: url.href.replace(/\/$/, ''), blockName, requestTimeoutMs }
}

/** Render any thrown value without letting the render itself throw. */
function renderError(error: unknown): string {
  try {
    return String(error instanceof Error ? error.message : error)
  } catch {
    return '[unrenderable thrown value]'
  }
}

/** Extract the bridge's `error` text from a non-2xx body, best effort. */
function bodyError(text: string): string | undefined {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value === 'object' && value !== null
      && typeof (value as { error?: unknown })['error'] === 'string') {
      return (value as { error: string })['error']
    }
  } catch {
    // The status code still names the failure.
  }
  return undefined
}

/** One verify round-trip: POST the source to the bridge's `/run` verify action. */
async function postVerify(resolved: ResolvedConfig, runId: string, source: string): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`${resolved.baseUrl}/run`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ runId, action: 'verify', blockName: resolved.blockName, source }),
      signal: AbortSignal.timeout(resolved.requestTimeoutMs),
    })
  } catch (error) {
    throw new Error(`openness bridge unreachable at ${resolved.baseUrl}/run: ${renderError(error)}`)
  }
  const text = await response.text()
  if (response.status < 200 || response.status >= 300) {
    const detail = bodyError(text)
    throw new Error(
      `openness bridge /run returned HTTP ${response.status}${detail === undefined ? '' : `: ${detail}`}`,
    )
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`openness bridge /run returned malformed JSON: ${renderError(error)}`)
  }
}

/** The fail-closed report for an unavailable bridge, wire, or run failure. */
function unavailableReport(detail: string): VerificationReport {
  return {
    kind: TIA_COMPILE_KIND,
    pass: false,
    diagnostics: [{
      code: 'tia-compile-unavailable',
      severity: 'error',
      message: `real TIA compile unavailable: ${detail}`,
    }],
    evidence: [{
      kind: 'tia-compile-unavailable',
      summary: `real TIA compile unavailable: ${detail}`,
    }],
  }
}

/** The local guard for an empty submission: no bridge round-trip runs. */
function emptyInputReport(): VerificationReport {
  return {
    kind: TIA_COMPILE_KIND,
    pass: false,
    diagnostics: [{
      code: 'tia-compile-empty-input',
      severity: 'error',
      message: 'the tia-compile verifier needs non-empty TIA SCL source text (a FUNCTION or FUNCTION_BLOCK definition)',
    }],
    evidence: [{
      kind: 'tia-compile',
      summary: 'submission was empty; the bridge round-trip was skipped',
    }],
  }
}

/** The fail-closed report when the bridge imported the block unsuccessfully. */
function importFailedReport(detail: string): VerificationReport {
  return {
    kind: TIA_COMPILE_KIND,
    pass: false,
    diagnostics: [{
      code: 'tia-compile-import-failed',
      severity: 'error',
      message: `the block could not be imported into the TIA project: ${detail}`,
    }],
    evidence: [{
      kind: 'tia-compile',
      summary: `block import failed: ${detail}`,
    }],
  }
}

/** Run one real-TIA compile verdict over the submitted source. */
async function verifyTiaCompile(resolved: ResolvedConfig, input: VerificationInput): Promise<VerificationReport> {
  // External compile adapters read the vendor-dialect source when one is
  // supplied; local-dialect `text` alone still works through direct ia_verify.
  const source = input.vendorSource === undefined ? input.text : input.vendorSource
  if (source.trim().length === 0) return emptyInputReport()
  let parsed: TiaCompileRunResponse
  try {
    parsed = parseTiaCompileRunResponse(await postVerify(resolved, randomUUID(), source))
  } catch (error) {
    return unavailableReport(renderError(error))
  }
  if (parsed.status !== 'success' || parsed.result === undefined) {
    const detail = parsed.error ?? `the bridge run ended in status ${parsed.status}`
    return parsed.status === 'diverged' ? importFailedReport(detail) : unavailableReport(detail)
  }
  const result = parsed.result
  const states = result.compileMessageStates
  const diagnostics: Diagnostic[] = []
  const kept = Math.min(result.compileMessages.length, MAX_DIAGNOSTICS)
  for (const [index, message] of result.compileMessages.slice(0, kept).entries()) {
    const state = states?.[index] ?? (index < result.compileErrors ? 'error' : 'warning')
    // Informational compiler lines (e.g. "Block was successfully compiled.")
    // are not findings; only error and warning messages become diagnostics.
    if (state === 'info') continue
    diagnostics.push({
      code: state === 'error' ? 'tia-compile-error' : 'tia-compile-warning',
      severity: state === 'error' ? 'error' : 'warning',
      message,
    })
  }
  // The closed verdict follows the diagnostics, so a compiler count without a
  // matching message still fails the report instead of silently passing.
  if (result.compileErrors > 0 && !diagnostics.some(diagnostic => diagnostic.severity === 'error')) {
    diagnostics.push({
      code: 'tia-compile-error',
      severity: 'error',
      message: `the TIA compiler reported ${result.compileErrors} error(s) without further messages`,
    })
  }
  const omitted = result.compileMessages.length - kept
  return {
    kind: TIA_COMPILE_KIND,
    pass: !diagnostics.some(diagnostic => diagnostic.severity === 'error'),
    diagnostics,
    evidence: [{
      kind: 'tia-compile',
      summary: `real TIA Portal compile of block ${result.blockName ?? resolved.blockName}: `
        + `${result.compileErrors} error(s), ${result.compileWarnings} warning(s) in ${result.compileMs} ms`,
      detail: `bridge run ${parsed.runId}${omitted > 0 ? `; ${omitted} further message(s) omitted from the diagnostics` : ''}`,
    }],
  }
}

/**
 * Load the openness compile verifier: register the `tia-compile` validator
 * kind into `ctx.iaVerifiers`. Registration is an effect — disposing the
 * plugin fiber removes the kind again.
 * @param ctx - Cordis context carrying the verifier registry.
 * @param config - bridge URL and block-name configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  ctx.effect(() => ctx.iaVerifiers.register({
    kind: TIA_COMPILE_KIND,
    title: 'TIA Portal Openness compile check',
    description:
      'Real vendor adjudication: imports the submitted TIA SCL block into the configured TIA project through the Openness bridge and compiles it. '
      + 'Reads input.vendorSource when present, else input.text; the source must define a block named exactly after the configured blockName '
      + '(TIA SCL: FUNCTION/FUNCTION_BLOCK ... END_FUNCTION, not the harness PROGRAM dialect).',
    verify: input => verifyTiaCompile(resolved, input),
  }))
}
