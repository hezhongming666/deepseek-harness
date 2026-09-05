/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-ia-verifier`.
 * It proves the report contract mechanically: every registered validator's
 * report must keep `pass` consistent with its error-severity diagnostics.
 * @module @deepseek-ai/dsh-ia-verifier/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-ia-verifier'

/** Cordis companion plugin name. */
export const name = 'ia-verifier-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Install the report-contract checks over every registered validator. */
const install: InvariantInstaller = Object.assign(async (ctx: Context, fail: InvariantFailure) => {
  const verifiers = ctx.iaVerifiers
  for (const kind of verifiers.kinds()) {
    const report = await verifiers.verify(kind, { text: '' })
    const hasError = report.diagnostics.some(d => d.severity === 'error')
    if (report.pass === hasError) {
      fail(`verifier ${JSON.stringify(kind)} returned pass=${report.pass} with ${hasError ? '' : 'no '}error diagnostics — pass must be false exactly when an error diagnostic exists`)
    }
    if (report.kind !== kind) {
      fail(`verifier ${JSON.stringify(kind)} returned a report for kind ${JSON.stringify(report.kind)}`)
    }
    if (report.evidence.length === 0) {
      fail(`verifier ${JSON.stringify(kind)} returned a report without evidence`)
    }
  }
}, { inject: ['iaVerifiers'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
