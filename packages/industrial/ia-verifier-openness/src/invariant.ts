/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-ia-verifier-openness`.
 * @module @deepseek-ai/dsh-ia-verifier-openness/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-ia-verifier-openness'

/** Cordis companion plugin name. */
export const name = 'ia-verifier-openness-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

// No runtime invariant: the plugin's only contribution is one `tia-compile`
// validator registration into the shared `ctx.iaVerifiers` registry; the
// registry's own companion (@deepseek-ai/dsh-ia-verifier/invariant) verifies
// the report contract of every registered kind, and this package's unit tests
// prove the local empty-input guard and the disposal of the registration.
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
