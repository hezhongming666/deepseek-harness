/**
 * Knowledge persistence: entries written to `dataDir` survive a restart,
 * fresh directories start clean, and corrupt or wrong-version snapshots fail
 * loud at load.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import IaKnowledgeService from '@deepseek-ai/dsh-ia-knowledge'

let dir: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function dataDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'dsh-ia-knowledge-data-'))
  return dir
}

async function makeKnowledge(config: { dataDir?: string } = {}): Promise<IaKnowledgeService> {
  context = new Context()
  await context.plugin(IaKnowledgeService, config)
  return context.iaKnowledge
}

describe('ia-knowledge persistence', () => {
  it('restores entries, review status, and the ordinal across restarts', async () => {
    const dir = dataDir()
    let knowledge = await makeKnowledge({ dataDir: dir })
    const recorded = knowledge.record({
      library: 'cases', title: 'Timeout case', content: 'cylinder timeout mismatch',
      source: 'proj-1', version: 'v1', recordedBy: 'agent', reviewStatus: 'pending-review',
    })
    knowledge.approveEntry(recorded.id)
    const second = knowledge.record({
      library: 'templates', title: 'Conveyor skeleton', content: 'PROGRAM template',
      source: 'tpl-1', version: 'v3', recordedBy: 'agent', reviewStatus: 'pending-review',
    })
    await context!.fiber.dispose()
    context = undefined

    knowledge = await makeKnowledge({ dataDir: dir })
    const restored = knowledge.entriesList('cases')[0]!
    expect(restored.title).toBe('Timeout case')
    expect(restored.reviewStatus).toBe('approved')
    expect(restored.recordedAt).toBe(recorded.recordedAt)
    expect(restored.source).toBe('proj-1')
    expect(knowledge.entriesList('templates')[0]!.version).toBe('v3')
    expect(knowledge.search('cases', 'timeout').hits).toHaveLength(1)
    // The ordinal survived, so new ids never collide with restored ones.
    expect(knowledge.record({
      library: 'cases', title: 'Later case', content: 'later', source: 's', version: 'v', recordedBy: 'a', reviewStatus: 'pending-review',
    }).id).not.toBe(second.id)
  })

  it('starts clean on a fresh data directory', async () => {
    const knowledge = await makeKnowledge({ dataDir: dataDir() })
    expect(knowledge.entriesList('cases')).toEqual([])
    expect(knowledge.readiness().ready).toBe(false)
  })

  it('fails loud on a malformed snapshot', async () => {
    const dir = dataDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'ia-knowledge.json'), '{not json')
    await expect(makeKnowledge({ dataDir: dir })).rejects.toThrow(/malformed JSON/)
  })

  it('fails loud on a wrong snapshot version', async () => {
    const dir = dataDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'ia-knowledge.json'), JSON.stringify({ version: 99, state: {} }))
    await expect(makeKnowledge({ dataDir: dir })).rejects.toThrow(/format version 99, expected 1/)
  })

  it('fails loud when the snapshot write fails after the memory commit', async () => {
    const dir = dataDir()
    const knowledge = await makeKnowledge({ dataDir: dir })
    // A directory squatting on the snapshot path makes the atomic rename fail.
    mkdirSync(join(dir, 'ia-knowledge.json'), { recursive: true })
    expect(() => knowledge.record({
      library: 'cases', title: 'Blocked write', content: 'x', source: 's', version: 'v', recordedBy: 'a', reviewStatus: 'pending-review',
    })).toThrow(/committed in memory but the snapshot write failed/)
    expect(knowledge.entriesList('cases')).toHaveLength(1)
  })
})
