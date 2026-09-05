/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-ia-knowledge`.
 * It proves the citation contract after every committed mutation: every
 * entry carries a non-empty source and version, ids stay unique, and the
 * closed library/review vocabularies hold.
 * @module @deepseek-ai/dsh-ia-knowledge/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-ia-knowledge'
const REVIEW_STATUSES = new Set(['pending-review', 'approved'])

/** Cordis companion plugin name. */
export const name = 'ia-knowledge-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Validate the citation and vocabulary contracts of every recorded entry. */
function validate(ctx: Context, fail: InvariantFailure): void {
  const seen = new Set<string>()
  const libraries = ctx.iaKnowledge.libraries()
  for (const library of libraries) {
    for (const entry of ctx.iaKnowledge.entriesList(library)) {
      if (seen.has(String(entry.id))) fail(`knowledge entry id ${String(entry.id)} is duplicated`)
      seen.add(String(entry.id))
      if (entry.source.length === 0) fail(`entry ${String(entry.id)} has an empty source citation`)
      if (entry.version.length === 0) fail(`entry ${String(entry.id)} has an empty version citation`)
      if (!libraries.includes(entry.library)) fail(`entry ${String(entry.id)} has invalid library ${entry.library}`)
      if (!REVIEW_STATUSES.has(entry.reviewStatus)) {
        fail(`entry ${String(entry.id)} has invalid reviewStatus ${entry.reviewStatus}`)
      }
    }
  }
}

/** Install the citation checks over the live knowledge service. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  validate(ctx, fail)
  ctx.iaKnowledge.onMutate(() => {
    validate(ctx, fail)
  })
}, { inject: ['iaKnowledge'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
