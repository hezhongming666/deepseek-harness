/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-ia-orchestrator`.
 * It proves the stage-machine contract after every committed mutation:
 * non-pending stages have all predecessors passed, attempts never exceed the
 * budget, escalated stages carry their package, and passed stages hold only
 * passing verification reports.
 * @module @deepseek-ai/dsh-ia-orchestrator/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-ia-orchestrator'

/** Cordis companion plugin name. */
export const name = 'ia-orchestrator-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Validate the stage-machine invariants of every instantiated project. */
function validate(ctx: Context, fail: InvariantFailure): void {
  for (const project of ctx.iaOrchestrator.projectsList()) {
    for (let index = 0; index < project.stages.length; index++) {
      const stage = project.stages[index]
      if (stage === undefined) continue
      if (index > 0 && stage.state !== 'pending') {
        for (const predecessor of project.stages.slice(0, index)) {
          if (predecessor.state !== 'passed') {
            fail(`project ${String(project.id)} stage ${String(stage.id)} is ${stage.state} before ${String(predecessor.id)} passed`)
          }
        }
      }
      if (stage.attempts > stage.maxRetries) {
        fail(`project ${String(project.id)} stage ${String(stage.id)} attempts ${stage.attempts} exceed maxRetries ${stage.maxRetries}`)
      }
      if (stage.state === 'escalated' && stage.escalation === undefined) {
        fail(`project ${String(project.id)} stage ${String(stage.id)} is escalated without an escalation package`)
      }
      if (stage.state === 'gated' && stage.gate === undefined) {
        fail(`project ${String(project.id)} stage ${String(stage.id)} is gated without a bound gate`)
      }
      if (stage.state === 'passed' && stage.verifiers.length > 0) {
        if (stage.reports === undefined || stage.reports.length === 0 || stage.reports.some(report => !report.pass)) {
          fail(`project ${String(project.id)} stage ${String(stage.id)} passed without fully passing verification reports`)
        }
      }
    }
  }
}

/** Install the stage-machine checks over the live orchestrator. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  validate(ctx, fail)
  ctx.iaOrchestrator.onMutate(() => {
    validate(ctx, fail)
  })
}, { inject: ['iaOrchestrator'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
