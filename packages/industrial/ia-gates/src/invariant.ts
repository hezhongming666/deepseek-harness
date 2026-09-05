/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-ia-gates`.
 * It proves the governance contract after every committed mutation: the six
 * mandatory gates always exist with their fixed always-human classification,
 * every request references a registered gate, and always-human gates can only
 * be decided by the human approval channel.
 * @module @deepseek-ai/dsh-ia-gates/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-ia-gates'

/** The six mandatory gate ids, fixed by the architecture §5.2. */
const MANDATORY: ReadonlyArray<readonly [string, boolean]> = [
  ['requirement-baseline', false],
  ['design-review', false],
  ['sil-review', true],
  ['first-power-on', true],
  ['acceptance-signoff', true],
  ['online-change', true],
]

/** Cordis companion plugin name. */
export const name = 'ia-gates-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Validate the governance snapshot of the gate engine. */
function validate(ctx: Context, fail: InvariantFailure): void {
  const gates = ctx.iaGates.gatesList()
  for (const [id, alwaysHuman] of MANDATORY) {
    const gate = gates.find(candidate => String(candidate.id) === id)
    if (gate === undefined) fail(`mandatory gate ${JSON.stringify(id)} is missing`)
    else if (gate.alwaysHuman !== alwaysHuman) {
      fail(`mandatory gate ${JSON.stringify(id)} alwaysHuman is ${gate.alwaysHuman}, expected ${alwaysHuman}`)
    }
  }
  const ids = new Set(gates.map(gate => String(gate.id)))
  const requestIds = new Set<number>()
  for (const request of ctx.iaGates.requests()) {
    if (!ids.has(String(request.gateId))) {
      fail(`gate request ${request.id} references unknown gate ${JSON.stringify(String(request.gateId))}`)
    }
    if (requestIds.has(request.id)) fail(`gate request id ${request.id} is duplicated`)
    requestIds.add(request.id)
    const gate = gates.find(candidate => candidate.id === request.gateId)
    if (request.decision !== undefined && gate?.alwaysHuman === true
      && request.decision.decider.startsWith('rule:')) {
      fail(`always-human gate ${JSON.stringify(String(request.gateId))} was decided by ${request.decision.decider}`)
    }
  }
}

/** Install the governance checks over the live gate engine. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  validate(ctx, fail)
  ctx.iaGates.onMutate(() => {
    validate(ctx, fail)
  })
}, { inject: ['iaGates'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
