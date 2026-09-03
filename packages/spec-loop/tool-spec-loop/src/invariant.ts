/** Package-owned tool-spec-loop runtime invariants. @module @deepseek-ai/dsh-tool-spec-loop/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
// Declaration merge only: makes ctx.invariants visible for registration.
import type {} from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-spec-loop'

/** Cordis companion plugin name. */
export const name = 'tool-spec-loop-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

// No runtime invariant: this model-facing tool adapter has no independent
// lifecycle stream; execution goes through ctx.tools and ctx.llm, whose own
// registries and invariants own the observed relationships, and the engine
// report is the complete per-call output.
const install: InvariantInstaller = () => {}

/**
 * Register the tool-spec-loop invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
