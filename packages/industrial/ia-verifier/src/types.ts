/**
 * Shared vocabulary of the deterministic verification layer: verification
 * reports, diagnostics, evidence, and the validator registration contract.
 * @module @deepseek-ai/dsh-ia-verifier
 */

/** One source position, one-based, for a diagnostic anchored in the checked text. */
export interface SourcePosition {
  /** One-based line number. */
  line: number
  /** One-based column number. */
  column: number
}

/**
 * One finding a validator produced. `severity` decides the report's verdict:
 * any `'error'` fails the check; `'warning'`s are advisory and never fail.
 */
export interface Diagnostic {
  /** Stable machine-readable finding code, unique per validator kind. */
  code: string
  /** Human-readable finding description. */
  message: string
  /** `'error'` fails the check; `'warning'` does not. */
  severity: 'error' | 'warning'
  /** Source position, present when the finding anchors to the checked text. */
  position?: SourcePosition
  /** Short offending source excerpt, when helpful. */
  excerpt?: string
}

/**
 * One adjudication evidence item. Evidence is the durable, machine-readable
 * residue of a verification run — it backs gate decisions and escalation
 * packages, so it carries a machine-friendly `kind` plus bounded human detail.
 */
export interface EvidenceItem {
  /** Stable evidence category, e.g. `'syntax'`, `'declarations'`, `'io-map'`. */
  kind: string
  /** One-line summary of what this evidence records. */
  summary: string
  /** Optional bounded detail (counts, hashes, matched rule names). */
  detail?: string
}

/**
 * The closed verdict of one deterministic verification run: `pass` is false
 * exactly when at least one diagnostic has severity `'error'`.
 */
export interface VerificationReport {
  /** The validator kind that produced this report. */
  kind: string
  /** Whether the checked input passed: no `'error'` diagnostics. */
  pass: boolean
  /** All findings, errors and warnings, in source order where positioned. */
  diagnostics: Diagnostic[]
  /** Machine-readable evidence backing the verdict. */
  evidence: EvidenceItem[]
}

/**
 * Input to one verification run. Validators read only this value — the
 * contract is a pure function of it, so the same input yields the same report
 * (the design's determinism requirement). Semantics per kind: `st-syntax` and
 * `st-lint` expect IEC 61131-3 Structured Text; `io-consistency` expects the
 * JSON document described in the package README. Local validators read
 * `text`; external compile adapters (e.g. `tia-compile`) read `vendorSource`
 * and fall back to `text` when it is absent.
 */
export interface VerificationInput {
  /** The checked source text or JSON payload. */
  text: string
  /**
   * Optional vendor-dialect source for external compile adapters, e.g. the
   * TIA SCL block a `tia-compile` run imports into the vendor project. Local
   * validators ignore it.
   */
  vendorSource?: string
  /** Optional file name used only for diagnostic framing. */
  fileName?: string
}

/**
 * A named deterministic validator registered in the registry. `verify` must be
 * deterministic — no model calls, no clock or environment reads that change
 * the verdict — because gate decisions rely on its output being reproducible.
 * It may be asynchronous (a vendor compile adapter round-trips an external
 * tool); local validators settle immediately.
 */
export interface ValidatorDescriptor {
  /** Registry key, e.g. `'st-syntax'`. Unique per registry. */
  kind: string
  /** Human-readable validator title. */
  title: string
  /** What this validator checks and what its input must be. */
  description: string
  /**
   * Run one deterministic check over the input.
   * @param input - the checked text or JSON payload.
   * @returns the report whose verdict follows the error-severity rule.
   */
  verify(input: VerificationInput): Promise<VerificationReport>
}

/** Error thrown when verification is requested for an unregistered kind. */
export class UnknownVerifierError extends Error {
  /** Stable machine-readable error code. */
  readonly code = 'IA_VERIFIER_UNKNOWN_KIND' as const

  /**
   * Construct the error naming the missing kind and the registered ones.
   * @param kind - the requested kind.
   * @param known - the currently registered kinds.
   */
  constructor(kind: string, known: readonly string[]) {
    super(`unknown verifier kind ${JSON.stringify(kind)}; registered: ${known.length > 0 ? known.join(', ') : '(none)'}`)
    this.name = 'UnknownVerifierError'
  }
}

/** Error thrown when a validator kind is registered twice. */
export class DuplicateVerifierError extends Error {
  /** Stable machine-readable error code. */
  readonly code = 'IA_VERIFIER_DUPLICATE_KIND' as const

  /**
   * Construct the error naming the duplicate kind.
   * @param kind - the already-registered kind.
   */
  constructor(kind: string) {
    super(`verifier kind ${JSON.stringify(kind)} is already registered`)
    this.name = 'DuplicateVerifierError'
  }
}
