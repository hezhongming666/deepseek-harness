/**
 * Gate-engine persistence: state written to `dataDir` survives a restart,
 * fresh directories start clean, and corrupt or wrong-version snapshots fail
 * loud at load.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import IaGatesService, { GateId } from '@deepseek-ai/dsh-ia-gates'

let dir: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function dataDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'dsh-ia-gates-data-'))
  return dir
}

async function makeGates(config: { level?: 'A0' | 'A1' | 'A2' | 'A3'; dataDir?: string } = {}): Promise<IaGatesService> {
  context = new Context()
  await context.plugin(IaGatesService, config)
  return context.iaGates
}

describe('ia-gates persistence', () => {
  it('restores requests with decisions and the ordinal across restarts', async () => {
    const dir = dataDir()
    let gates = await makeGates({ dataDir: dir })
    gates.registerGate({ id: GateId('extra-review'), title: 'Extra review', description: 'project gate', alwaysHuman: false })
    const first = gates.request(GateId('requirement-baseline'), 'agent-1', { reason: 'r1', evidence: ['e1'] })
    first.decision = { outcome: 'approved', decider: 'human', rationale: 'ok', decidedAt: 1234 }
    const second = gates.request(GateId('extra-review'), 'agent-2', { reason: 'r2', evidence: [] })
    expect(second.id).toBeGreaterThan(first.id)
    await context!.fiber.dispose()
    context = undefined

    gates = await makeGates({ dataDir: dir })
    expect(gates.requestsFor(GateId('requirement-baseline'))).toHaveLength(1)
    const restoredFirst = gates.requestsFor(GateId('requirement-baseline'))[0]!
    expect(restoredFirst.context.reason).toBe('r1')
    expect(restoredFirst.decision?.outcome).toBe('approved')
    expect(restoredFirst.requestedAt).toBe(first.requestedAt)
    // Gate definitions are registration effects, not data: they re-register
    // at boot without conflicting with the restored request history.
    expect(gates.gatesList()).toHaveLength(6)
    gates.registerGate({ id: GateId('extra-review'), title: 'Extra review', description: 'project gate', alwaysHuman: false })
    expect(gates.requestsFor(GateId('extra-review'))[0]!.context.reason).toBe('r2')
    // The ordinal survived, so new requests never collide with restored ids.
    expect(gates.request(GateId('design-review'), 'agent-3', { reason: 'r3', evidence: [] }).id).toBeGreaterThan(second.id)
  })

  it('starts clean on a fresh data directory', async () => {
    const gates = await makeGates({ dataDir: dataDir() })
    expect(gates.requests()).toEqual([])
    expect(gates.gatesList()).toHaveLength(6)
  })

  it('fails loud on a malformed snapshot', async () => {
    const dir = dataDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'ia-gates.json'), '{not json')
    await expect(makeGates({ dataDir: dir })).rejects.toThrow(/malformed JSON/)
  })

  it('fails loud on a wrong snapshot version', async () => {
    const dir = dataDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'ia-gates.json'), JSON.stringify({ version: 99, state: {} }))
    await expect(makeGates({ dataDir: dir })).rejects.toThrow(/format version 99, expected 1/)
  })

  it('fails loud when the snapshot write fails after the memory commit', async () => {
    const dir = dataDir()
    const gates = await makeGates({ dataDir: dir })
    // A directory squatting on the snapshot path makes the atomic rename fail.
    mkdirSync(join(dir, 'ia-gates.json'), { recursive: true })
    expect(() => gates.request(GateId('design-review'), 'agent', { reason: 'r', evidence: [] }))
      .toThrow(/committed in memory but the snapshot write failed/)
    // The memory commit still happened (the divergence is the documented semantics).
    expect(gates.requestsFor(GateId('design-review'))).toHaveLength(1)
  })
})
