/**
 * Trace persistence: scoped projects written to `dataDir` survive a restart,
 * fresh directories start clean, and corrupt or wrong-version snapshots fail
 * loud at load.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import IaTraceService from '@deepseek-ai/dsh-ia-trace'

let dir: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function dataDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'dsh-ia-trace-data-'))
  return dir
}

async function makeTrace(config: { dataDir?: string } = {}): Promise<IaTraceService> {
  context = new Context()
  await context.plugin(IaTraceService, config)
  return context.iaTrace
}

describe('ia-trace persistence', () => {
  it('restores scoped projects with nodes, links, changes, and ordinals across restarts', async () => {
    const dir = dataDir()
    let trace = await makeTrace({ dataDir: dir })
    const a = trace.project('scope-a')
    const req = a.addNode({ kind: 'requirement', title: 'R1', author: 'agent', tags: ['conveyor'] })
    const des = a.addNode({ kind: 'design', title: 'D1', author: 'agent' })
    a.addLink(req.id, des.id, 'derives')
    a.recordChange({ nodeIds: [des.id], author: 'human', reason: 'rework' })
    const b = trace.project('scope-b')
    b.addNode({ kind: 'test', title: 'T1', author: 'agent' })
    await context!.fiber.dispose()
    context = undefined

    trace = await makeTrace({ dataDir: dir })
    expect(trace.hasProject('scope-a')).toBe(true)
    expect(trace.hasProject('scope-b')).toBe(true)
    const restored = trace.project('scope-a')
    expect(restored.nodesList().map(node => node.title)).toEqual(['R1', 'D1'])
    expect(restored.linksList()[0]?.kind).toBe('derives')
    expect(restored.changesList()[0]?.reason).toBe('rework')
    expect(restored.node(req.id)?.createdAt).toBe(req.createdAt)
    expect(restored.matrix()[0]?.covered).toBe(false)
    expect(restored.impactOf([des.id]).direct).toEqual([])
    expect(trace.project('scope-b').nodesList()[0]?.title).toBe('T1')
    // Ordinals survive: fresh nodes never collide with restored ids.
    const fresh = restored.addNode({ kind: 'test', title: 'T2', author: 'agent' })
    expect(fresh.id).not.toBe(req.id)
  })

  it('starts clean on a fresh data directory', async () => {
    const trace = await makeTrace({ dataDir: dataDir() })
    expect(trace.hasProject('anything')).toBe(false)
  })

  it('fails loud on a malformed snapshot', async () => {
    const dir = dataDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'ia-trace.json'), '{not json')
    await expect(makeTrace({ dataDir: dir })).rejects.toThrow(/malformed JSON/)
  })

  it('fails loud on a wrong snapshot version', async () => {
    const dir = dataDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'ia-trace.json'), JSON.stringify({ version: 99, state: {} }))
    await expect(makeTrace({ dataDir: dir })).rejects.toThrow(/format version 99, expected 1/)
  })

  it('fails loud when the snapshot write fails after the memory commit', async () => {
    const dir = dataDir()
    const trace = await makeTrace({ dataDir: dir })
    const project = trace.project('scope-x')
    project.addNode({ kind: 'test', title: 'first', author: 'agent' })
    // A directory squatting on the snapshot path makes the atomic rename fail.
    rmSync(join(dir, 'ia-trace.json'), { force: true })
    mkdirSync(join(dir, 'ia-trace.json'), { recursive: true })
    expect(() => project.addNode({ kind: 'test', title: 'blocked', author: 'agent' }))
      .toThrow(/committed in memory but the snapshot write failed/)
    expect(project.nodesList()).toHaveLength(2)
  })
})
