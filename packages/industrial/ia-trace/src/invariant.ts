/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-ia-trace`.
 * It proves the graph contract after every committed mutation: links always
 * reference existing nodes, and a node's change version always equals the
 * number of change records that touched it.
 * @module @deepseek-ai/dsh-ia-trace/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { TraceProject } from './index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-ia-trace'

/** Cordis companion plugin name. */
export const name = 'ia-trace-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Validate the cross-record relationships of one project snapshot. */
function validateProject(project: TraceProject, fail: InvariantFailure): void {
  const nodes = project.nodesList()
  const ids = new Set(nodes.map(node => node.id))
  for (const link of project.linksList()) {
    if (!ids.has(link.from)) fail(`link from ${JSON.stringify(String(link.from))} references an unknown node`)
    if (!ids.has(link.to)) fail(`link to ${JSON.stringify(String(link.to))} references an unknown node`)
  }
  for (const node of nodes) {
    const touches = project.changesList().filter(record => record.nodeIds.includes(node.id)).length
    if (node.changeVersion !== touches) {
      fail(`node ${JSON.stringify(String(node.id))} changeVersion ${node.changeVersion} does not match its ${touches} change record(s)`)
    }
  }
}

/** Install the graph-contract checks over every opened project. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.iaTrace.onProjectOpen((project: TraceProject) => {
    validateProject(project, fail)
    // Listeners ride the project lifetime: mutations keep the snapshot honest.
    project.onMutate(() => {
      validateProject(project, fail)
    })
  })
}, { inject: ['iaTrace'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
