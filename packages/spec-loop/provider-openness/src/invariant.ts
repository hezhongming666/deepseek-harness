/** Package-owned provider-openness runtime invariants. @module @deepseek-ai/dsh-provider-openness/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
// Declaration merge only: makes ctx.invariants visible for registration.
import type {} from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-provider-openness'

/** Cordis companion plugin name. */
export const name = 'provider-openness-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

// No runtime invariant: the adapter is a per-call bridge client whose
// observable behavior is the validate/run outcome sequence recorded per spec
// loop; the spawn-mode bridge lifecycle (readiness line, kill-on-dispose) is
// disposal-tested rather than event-observable.
const install: InvariantInstaller = () => {}

/**
 * Register the provider-openness invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
