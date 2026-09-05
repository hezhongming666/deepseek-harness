/**
 * Gate engine — the design's human-collaboration boundary. The six mandatory
 * gates from the architecture §5.2 ship with the service and cannot be
 * removed; dangerous gates stay human at every automation level (§5.1), and
 * decisions enter only through the human approval channel or a registered
 * A2/A3 auto-release rule. Agents can request gates, never decide them.
 * @module @deepseek-ai/dsh-ia-gates
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AlwaysHumanGateError, DuplicateGateError, GateId, UnknownGateError } from './types.ts'
import type {
  AutomationLevel,
  AutoReleaseRule,
  GateDecision,
  GateDefinition,
  GateRegistration,
  GateRequest,
  GateRequestContext,
  HumanDecisionOutcome,
} from './types.ts'

// The approval-channel Context face, read through ctx.get so the gate engine
// stays composed even when no approval service is mounted.
import type {} from '@deepseek-ai/dsh-user-approval'

declare module '@deepseek-ai/cordis' {
  interface Context {
    iaGates: IaGatesService
  }
}

/**
 * The six mandatory human gates of the architecture §5.2. Their
 * `alwaysHuman` classification follows §5.1: dangerous operations stay human
 * at every automation level.
 */
const MANDATORY_GATES: ReadonlyArray<GateRegistration> = [
  {
    id: GateId('requirement-baseline'),
    title: 'Requirement baseline confirmation',
    description: 'The customer confirms the structured requirement matrix and the clarification answers.',
    alwaysHuman: false,
  },
  {
    id: GateId('design-review'),
    title: 'Design review',
    description: 'A human approves the control scheme, selection, IO estimate, and safety pre-assessment.',
    alwaysHuman: false,
  },
  {
    id: GateId('sil-review'),
    title: 'Safety-function final review',
    description: 'A certified engineer signs off safety-related (SIL-rated) artifacts; agents only draft them.',
    alwaysHuman: true,
  },
  {
    id: GateId('first-power-on'),
    title: 'First power-on and energized actions',
    description: 'A human executes first energization; the agent only prepares scripts and verifies afterwards.',
    alwaysHuman: true,
  },
  {
    id: GateId('acceptance-signoff'),
    title: 'Acceptance signature',
    description: 'The acceptance authority signs the delivered documentation package.',
    alwaysHuman: true,
  },
  {
    id: GateId('online-change'),
    title: 'Production-affecting online change',
    description: 'Any change that affects a live production line is deployed only by a human decision.',
    alwaysHuman: true,
  },
]

/**
 * Gate service configuration.
 */
export interface Config {
  /**
   * Deployment automation level, one of `A0`–`A3` (default `A1`). Anything
   * else fails at load.
   */
  level?: AutomationLevel
}

/** Schemastery configuration for the gate engine. */
export const Config: Schema<Config> = z.object({
  level: z.union([z.const('A0'), z.const('A1'), z.const('A2'), z.const('A3')]).default('A1'),
})

/**
 * The gate engine. Requests are append-only records; decisions enter through
 * {@link IaGatesService.requestHumanDecision} (the approval channel) or a
 * registered auto-release rule evaluated at level A2/A3.
 */
export class IaGatesService extends Service {
  static Config: Schema<Config> = Config

  private readonly level: AutomationLevel
  private readonly gates = new Map<GateId, GateDefinition>()
  private readonly rules = new Map<GateId, { id: string; rule: AutoReleaseRule }>()
  private readonly requestsByGate = new Map<GateId, GateRequest[]>()
  private ordinal = 0
  private readonly listeners = new Set<() => void>()

  /**
   * Create the gate engine and register the six mandatory gates.
   * @param ctx - Cordis context that owns the service.
   * @param config - the deployment automation level.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'iaGates')
    // The schema's literal union rejects other values before construction.
    this.level = config.level ?? 'A1'
    for (const gate of MANDATORY_GATES) {
      this.gates.set(gate.id, { ...gate, mandatory: true })
    }
  }

  /** Read the deployment automation level.
   * @returns the deployment automation level. */
  automationLevel(): AutomationLevel {
    return this.level
  }

  /**
   * Register one project-specific gate. Mandatory gate ids are reserved and
   * cannot be re-registered.
   * @param definition - the gate definition; `mandatory` is forced to false.
   * @returns a disposer removing the gate.
   */
  registerGate(definition: GateRegistration): () => void {
    const gate: GateDefinition = { ...definition, mandatory: false }
    if (this.gates.has(gate.id)) throw new DuplicateGateError(gate.id)
    if (gate.title.trim().length === 0) throw new Error('iaGates: gate `title` must be non-empty')
    this.gates.set(gate.id, gate)
    return () => {
      this.gates.delete(gate.id)
    }
  }

  /**
   * Register one auto-release rule. Rules apply only at automation level A2
   * or A3, and never to always-human gates.
   * @param id - the rule id, used as the decision's decider label.
   * @param gateId - the target gate.
   * @param rule - the deterministic predicate over the request context.
   * @returns a disposer removing the rule.
   */
  registerAutoReleaseRule(id: string, gateId: GateId, rule: AutoReleaseRule): () => void {
    const gate = this.gates.get(gateId)
    if (gate === undefined) throw new UnknownGateError(gateId)
    if (gate.alwaysHuman) throw new AlwaysHumanGateError(gateId)
    this.rules.set(gateId, { id, rule })
    return () => {
      this.rules.delete(gateId)
    }
  }

  /** List every registered gate.
   * @returns all registered gates, mandatory first. */
  gatesList(): GateDefinition[] {
    return [...this.gates.values()]
  }

  /** List every recorded request.
   * @returns all requests across gates, in recording order. */
  requests(): GateRequest[] {
    return [...this.requestsByGate.values()].flat()
  }

  /** Read the requests recorded for one gate.
   * @param gateId - the gate whose requests to read.
   * @returns the requests recorded for the gate, oldest first. */
  requestsFor(gateId: GateId): GateRequest[] {
    if (!this.gates.has(gateId)) throw new UnknownGateError(gateId)
    return [...this.requestsByGate.get(gateId) ?? []]
  }

  /**
   * Ask one gate to release. At level A2/A3 a registered auto-release rule
   * decides immediately; otherwise the request stays pending for the human
   * channel.
   * @param gateId - the gate to ask.
   * @param requestedBy - the asking agent or human identity.
   * @param context - the decision context.
   * @returns the recorded request, possibly already decided.
   */
  request(gateId: GateId, requestedBy: string, context: GateRequestContext): GateRequest {
    if (!this.gates.has(gateId)) throw new UnknownGateError(gateId)
    if (requestedBy.trim().length === 0) throw new Error('iaGates: `requestedBy` must be non-empty')
    this.ordinal += 1
    const request: GateRequest = {
      id: this.ordinal,
      gateId,
      requestedBy: requestedBy.trim(),
      context,
      requestedAt: Date.now(),
    }
    const list = this.requestsByGate.get(gateId) ?? []
    list.push(request)
    this.requestsByGate.set(gateId, list)

    const level = this.level
    const registration = this.rules.get(gateId)
    if ((level === 'A2' || level === 'A3') && registration !== undefined) {
      const passes = registration.rule(context)
      request.decision = {
        outcome: passes ? 'approved' : 'rejected',
        decider: `rule:${registration.id}`,
        rationale: passes
          ? `auto-release rule ${registration.id} passed at automation level ${level}`
          : `auto-release rule ${registration.id} failed at automation level ${level}`,
        decidedAt: Date.now(),
      }
    }
    this.notify()
    return request
  }

  /**
   * Ask the composed approval channel for a human decision on the latest
   * pending request of one gate. The service itself never prompts anyone —
   * the approval seam does — and any answer that is not a grant leaves the
   * request pending.
   * @param gateId - the gate to decide.
   * @param agent - the agent on whose behalf the question is asked.
   * @returns what happened: `approved`, `rejected`, or `pending` when the
   *   channel is absent, unavailable, cancelled, or has no pending request.
   */
  async requestHumanDecision(gateId: GateId, agent: Agent): Promise<HumanDecisionOutcome> {
    const request = this.latestPending(gateId)
    if (request === undefined) return 'pending'
    const approval = this.ctx.get('approval')
    if (approval === undefined) return 'pending'
    const outcome = await approval.request({
      agent,
      toolName: 'ia_gate',
      reason: `gate ${String(gateId)}: ${request.context.reason}`,
    })
    if (outcome === 'allowed-once') {
      request.decision = {
        outcome: 'approved',
        decider: 'human-approval',
        rationale: request.context.reason,
        decidedAt: Date.now(),
      }
      this.notify()
      return 'approved'
    }
    if (outcome === 'rejected') {
      request.decision = {
        outcome: 'rejected',
        decider: 'human-approval',
        rationale: request.context.reason,
        decidedAt: Date.now(),
      }
      this.notify()
      return 'rejected'
    }
    return 'pending'
  }

  /** The latest request of one gate without a decision. */
  private latestPending(gateId: GateId): GateRequest | undefined {
    const list = this.requestsByGate.get(gateId) ?? []
    for (let index = list.length - 1; index >= 0; index--) {
      const request = list[index]
      if (request !== undefined && request.decision === undefined) return request
    }
    return undefined
  }

  /** Read the latest decision recorded for one gate.
   * @param gateId - the gate whose decision to read.
   * @returns the latest decision, or `undefined` when none exists. */
  latestDecision(gateId: GateId): GateDecision | undefined {
    if (!this.gates.has(gateId)) throw new UnknownGateError(gateId)
    const list = this.requestsByGate.get(gateId) ?? []
    for (let index = list.length - 1; index >= 0; index--) {
      const decision = list[index]?.decision
      if (decision !== undefined) return decision
    }
    return undefined
  }

  /** Subscribe to post-mutation notifications; the registration lives as long as the service.
   * @param listener - called after every committed mutation. */
  onMutate(listener: () => void): void {
    this.listeners.add(listener)
  }

  /** Publish a mutation to listeners after it has committed. */
  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

export default IaGatesService
export * from './types.ts'
