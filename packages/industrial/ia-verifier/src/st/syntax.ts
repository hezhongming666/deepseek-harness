/**
 * The `st-syntax` deterministic validator: tokenizes and parses the supported
 * Structured Text subset and reports every lexical and syntactic problem with
 * a source position. It is the local stand-in for a vendor compiler in the
 * design's verify-as-gate pipeline — always available, model-free, and pure.
 * @module @deepseek-ai/dsh-ia-verifier
 */

import type { Diagnostic, EvidenceItem, VerificationInput, VerificationReport } from '../types.ts'
import { parse } from './parser.ts'

/** Stable registry kind of this validator. */
export const ST_SYNTAX_KIND = 'st-syntax' as const

/**
 * Run the Structured Text syntax check.
 * @param input - the checked source text.
 * @returns the report; `pass` is false when any problem has severity `'error'`.
 */
export function verifyStSyntax(input: VerificationInput): VerificationReport {
  const { diagnostics } = parse(input.text)
  return buildReport(ST_SYNTAX_KIND, diagnostics, {
    kind: 'syntax',
    summary: diagnostics.length === 0 ? 'no syntax problems' : `${count(diagnostics, 'error')} error(s), ${count(diagnostics, 'warning')} warning(s)`,
    detail: `checked ${countLines(input.text)} line(s) of Structured Text`,
  })
}

/**
 * Compose a verification report from diagnostics plus evidence.
 * @param kind - the validator kind that produced the report.
 * @param diagnostics - all findings, errors and warnings.
 * @param evidence - the machine-readable evidence backing the verdict.
 * @returns the report whose verdict follows the error-severity rule.
 */
export function buildReport(
  kind: string,
  diagnostics: Diagnostic[],
  evidence: EvidenceItem,
): VerificationReport {
  return {
    kind,
    pass: diagnostics.every(d => d.severity !== 'error'),
    diagnostics,
    evidence: [evidence],
  }
}

/** Count diagnostics of one severity. */
function count(diagnostics: readonly Diagnostic[], severity: Diagnostic['severity']): number {
  return diagnostics.filter(d => d.severity === severity).length
}

/** Count non-empty lines of one text. */
function countLines(text: string): number {
  const lines = text.split('\n').filter(line => line.trim().length > 0)
  return lines.length
}
