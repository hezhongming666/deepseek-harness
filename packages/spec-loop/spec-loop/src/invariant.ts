/** Package-owned spec-loop runtime invariants. @module @deepseek-ai/dsh-spec-loop/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
// Declaration merge only: makes ctx.invariants visible for registration.
import type {} from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-spec-loop'

/** Cordis companion plugin name. */
export const name = 'spec-loop-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

// No runtime invariant: the engine is a per-call pure function of caller-owned
// inputs (the run report is the complete observable output) and the adapter
// seam owns no event stream or mutable registry; behavior is enforced by the
// engine and spec tests.
const install: InvariantInstaller = () => {}

/**
 * Register the spec-loop invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
