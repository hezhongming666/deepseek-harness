/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tool-ia`.
 * It proves the authority boundary mechanically: the registered `ia_gate`
 * tool exposes request/list actions and no decide action, so no model-facing
 * call can release a gate — decisions stay with the human channel and the
 * rule engine.
 * @module @deepseek-ai/dsh-tool-ia/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-ia'

/** Cordis companion plugin name. */
export const name = 'tool-ia-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** The tool names this package registers. */
const TOOL_NAMES = ['ia_verify', 'ia_trace', 'ia_gate', 'ia_knowledge', 'ia_project'] as const

/** Install the authority-boundary checks over the tool registry. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const schemas = ctx.tools.schemas()
  const names = new Set(schemas.map(schema => schema.name))
  for (const tool of TOOL_NAMES) {
    if (!names.has(tool)) {
      fail(`tool ${tool} is missing from the registry`)
    }
  }
  const gate = schemas.find(schema => schema.name === 'ia_gate')
  if (gate !== undefined) {
    const properties = gate.parameters.properties as Record<string, { enum?: readonly string[] }> | undefined
    const action = properties?.['action']
    const actions = new Set(action?.enum ?? [])
    if (actions.has('decide') || actions.has('approve') || actions.has('reject')) {
      fail('the ia_gate tool exposes a decision action — gate decisions must stay with humans and rule evaluation')
    }
  }
}, { inject: ['tools'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
