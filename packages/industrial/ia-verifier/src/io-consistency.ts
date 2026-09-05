/**
 * The `io-consistency` deterministic validator: the two-way IO-list ↔
 * symbol-table consistency check from the design's electrical/control
 * boundary. The input is a JSON document; every mismatch is a positioned
 * finding and the verdict follows the error-severity rule.
 * @module @deepseek-ai/dsh-ia-verifier
 */

import type { Diagnostic, VerificationInput, VerificationReport } from './types.ts'
import { buildReport } from './st/syntax.ts'

/** Stable registry kind of this validator. */
export const IO_CONSISTENCY_KIND = 'io-consistency' as const

/** One IO point row of the checked JSON document. */
interface IoEntry {
  /** Signal tag, matched one-to-one against symbol names. */
  tag: string
  /** Hardware address such as `%Q0.0`, unique per document. */
  address: string
}

/** One symbol-table row of the checked JSON document. */
interface SymbolEntry {
  /** Symbol name, matched one-to-one against IO tags. */
  name: string
}

/** The validated JSON document shape. */
interface IoDocument {
  /** IO point list. */
  io: IoEntry[]
  /** Symbol table. */
  symbols: SymbolEntry[]
}

/**
 * Run the IO-symbol consistency check over a JSON document.
 * @param input - the checked JSON text.
 * @returns the report; duplicate tags/addresses/names and symbols missing
 *   their IO point are errors, IO points without a symbol are warnings.
 */
export function verifyIoConsistency(input: VerificationInput): VerificationReport {
  const diagnostics: Diagnostic[] = []
  let io: IoEntry[] = []
  let symbols: SymbolEntry[] = []

  let document: IoDocument | undefined
  try {
    document = parseDocument(input.text)
  } catch (error) {
    diagnostics.push({
      code: 'io-consistency-invalid-json',
      message: `invalid input: ${error instanceof Error ? error.message : String(error)}`,
      severity: 'error',
    })
  }
  if (document !== undefined) {
    io = document.io
    symbols = document.symbols
    const seenTags = new Set<string>()
    const seenAddresses = new Set<string>()
    for (const entry of io) {
      if (typeof entry.tag !== 'string' || entry.tag.length === 0) {
        diagnostics.push({
          code: 'io-consistency-malformed-tag',
          message: 'every io entry needs a non-empty string `tag`',
          severity: 'error',
        })
        continue
      }
      if (typeof entry.address !== 'string' || entry.address.length === 0) {
        diagnostics.push({
          code: 'io-consistency-malformed-address',
          message: `io entry ${entry.tag} needs a non-empty string \`address\``,
          severity: 'error',
        })
        continue
      }
      if (seenTags.has(entry.tag)) {
        diagnostics.push({ code: 'io-consistency-duplicate-tag', message: `duplicate io tag ${entry.tag}`, severity: 'error' })
      }
      seenTags.add(entry.tag)
      if (seenAddresses.has(entry.address)) {
        diagnostics.push({ code: 'io-consistency-duplicate-address', message: `address ${entry.address} assigned to several io entries`, severity: 'error' })
      }
      seenAddresses.add(entry.address)
    }

    const seenNames = new Set<string>()
    for (const entry of symbols) {
      if (typeof entry.name !== 'string' || entry.name.length === 0) {
        diagnostics.push({
          code: 'io-consistency-malformed-name',
          message: 'every symbol entry needs a non-empty string `name`',
          severity: 'error',
        })
        continue
      }
      if (seenNames.has(entry.name)) {
        diagnostics.push({ code: 'io-consistency-duplicate-symbol', message: `duplicate symbol ${entry.name}`, severity: 'error' })
      }
      seenNames.add(entry.name)
    }

    for (const entry of io) {
      if (typeof entry.tag === 'string' && entry.tag.length > 0 && !seenNames.has(entry.tag)) {
        diagnostics.push({
          code: 'io-consistency-missing-symbol',
          message: `io point ${entry.tag} has no matching symbol`,
          severity: 'error',
        })
      }
    }
    for (const entry of symbols) {
      if (typeof entry.name === 'string' && entry.name.length > 0 && !seenTags.has(entry.name)) {
        diagnostics.push({
          code: 'io-consistency-orphan-symbol',
          message: `symbol ${entry.name} has no io point (local or interlock variable?)`,
          severity: 'warning',
        })
      }
    }
  }

  const errors = diagnostics.filter(d => d.severity === 'error').length
  return buildReport(IO_CONSISTENCY_KIND, diagnostics, {
    kind: 'io-map',
    summary: `${io.length} io point(s), ${symbols.length} symbol(s), ${errors} error(s), ${diagnostics.length - errors} warning(s)`,
    detail: 'two-way tag↔symbol consistency per the IO-symbol contract',
  })
}

/**
 * Parse and validate the IO document shape; structural problems throw.
 * @param text - the JSON text.
 * @returns the validated document.
 */
function parseDocument(text: string): IoDocument {
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null) {
    throw new Error('the document must be a JSON object')
  }
  const record = value as Record<string, unknown>
  if (!Array.isArray(record['io']) || !Array.isArray(record['symbols'])) {
    throw new Error('the document needs `io` and `symbols` arrays')
  }
  for (const entry of record['io']) {
    if (typeof entry !== 'object' || entry === null) throw new Error('every `io` entry must be an object')
  }
  for (const entry of record['symbols']) {
    if (typeof entry !== 'object' || entry === null) throw new Error('every `symbols` entry must be an object')
  }
  return { io: record['io'] as IoEntry[], symbols: record['symbols'] as SymbolEntry[] }
}
