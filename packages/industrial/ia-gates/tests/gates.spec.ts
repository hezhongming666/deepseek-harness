// Behavior of the gate engine: mandatory gates, automation levels,
// always-human dangerous gates, auto-release rules, and the human channel.
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import IaGatesService, { AlwaysHumanGateError, DuplicateGateError, GateId, UnknownGateError } from '@deepseek-ai/dsh-ia-gates'
import type { AutomationLevel } from '@deepseek-ai/dsh-ia-gates'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

async function makeGates(level?: 'A0' | 'A1' | 'A2' | 'A3'): Promise<IaGatesService> {
  context = new Context()
  await context.plugin(IaGatesService, level === undefined ? {} : { level })
  return context.iaGates
}

const CONTEXT = { reason: 'control program verified, requesting release', evidence: ['st-syntax pass'] }

describe('IaGatesService', () => {
  it('registers the six mandatory gates with their fixed classifications', async () => {
    const gates = await makeGates()
    const list = gates.gatesList()
    expect(list).toHaveLength(6)
    expect(list.every(gate => gate.mandatory)).toBe(true)
    const alwaysHuman = list.filter(gate => gate.alwaysHuman).map(gate => String(gate.id))
    expect(alwaysHuman).toEqual(['sil-review', 'first-power-on', 'acceptance-signoff', 'online-change'])
  })

  it('fails at load on an unknown automation level', async () => {
    context = new Context()
    await expect(context.plugin(IaGatesService, { level: 'A9' as AutomationLevel })).rejects.toThrow(/invalid config/)
  })

  it('defaults to automation level A1', async () => {
    expect((await makeGates()).automationLevel()).toBe('A1')
  })

  it('keeps mandatory gate ids reserved: re-registration fails', async () => {
    const gates = await makeGates()
    expect(() => gates.registerGate({
      id: GateId('design-review'),
      title: 'sneaky',
      description: 'trying to replace a mandatory gate',
      alwaysHuman: false,
    })).toThrow(DuplicateGateError)
  })

  it('registers project gates with effect-scoped disposers', async () => {
    const gates = await makeGates()
    const dispose = gates.registerGate({
      id: GateId('release-review'),
      title: 'Release review',
      description: 'project-specific release gate',
      alwaysHuman: false,
    })
    expect(gates.gatesList()).toHaveLength(7)
    dispose()
    expect(gates.gatesList()).toHaveLength(6)
  })

  it('requests a gate and leaves it pending at A1', async () => {
    const gates = await makeGates('A1')
    const request = gates.request(GateId('design-review'), 'design-agent', CONTEXT)
    expect(request.decision).toBeUndefined()
    expect(gates.requestsFor(GateId('design-review'))).toEqual([request])
    expect(gates.latestDecision(GateId('design-review'))).toBeUndefined()
  })

  it('fails loud on requests to unknown gates', async () => {
    const gates = await makeGates()
    expect(() => gates.request(GateId('nope'), 'me', CONTEXT)).toThrow(UnknownGateError)
  })

  it('applies an auto-release rule at A2 and decides immediately', async () => {
    const gates = await makeGates('A2')
    gates.registerAutoReleaseRule('standard-line', GateId('design-review'), ctx => ctx.evidence.some(e => e.includes('pass')))
    const request = gates.request(GateId('design-review'), 'design-agent', CONTEXT)
    expect(request.decision).toEqual(expect.objectContaining({
      outcome: 'approved',
      decider: 'rule:standard-line',
    }))
  })

  it('rejects through a failing auto-release rule at A2', async () => {
    const gates = await makeGates('A2')
    gates.registerAutoReleaseRule('standard-line', GateId('design-review'), () => false)
    const request = gates.request(GateId('design-review'), 'design-agent', CONTEXT)
    expect(request.decision).toEqual(expect.objectContaining({ outcome: 'rejected' }))
  })

  it('ignores auto-release rules below A2', async () => {
    const gates = await makeGates('A1')
    gates.registerAutoReleaseRule('standard-line', GateId('design-review'), () => true)
    expect(gates.request(GateId('design-review'), 'design-agent', CONTEXT).decision).toBeUndefined()
  })

  it('never allows auto-release rules on always-human gates', async () => {
    const gates = await makeGates('A3')
    expect(() => gates.registerAutoReleaseRule('x', GateId('first-power-on'), () => true)).toThrow(AlwaysHumanGateError)
    expect(() => gates.registerAutoReleaseRule('x', GateId('sil-review'), () => true)).toThrow(AlwaysHumanGateError)
    expect(() => gates.registerAutoReleaseRule('x', GateId('acceptance-signoff'), () => true)).toThrow(AlwaysHumanGateError)
    expect(() => gates.registerAutoReleaseRule('x', GateId('online-change'), () => true)).toThrow(AlwaysHumanGateError)
  })

  it('keeps always-human gates pending even at A3', async () => {
    const gates = await makeGates('A3')
    expect(gates.request(GateId('first-power-on'), 'site-agent', CONTEXT).decision).toBeUndefined()
  })

  it('records several requests per gate and finds the latest decision', async () => {
    const gates = await makeGates('A2')
    gates.registerAutoReleaseRule('r', GateId('design-review'), () => false)
    gates.request(GateId('design-review'), 'a', CONTEXT)
    gates.request(GateId('design-review'), 'a', CONTEXT)
    const list = gates.requestsFor(GateId('design-review'))
    expect(list).toHaveLength(2)
    expect(gates.latestDecision(GateId('design-review'))?.outcome).toBe('rejected')
    expect(gates.requests()).toHaveLength(2)
  })
})
