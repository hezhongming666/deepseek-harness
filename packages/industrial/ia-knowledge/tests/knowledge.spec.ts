// Behavior of the knowledge service: citations, dedup, deterministic
// retrieval, cold-start readiness, and the approval path.
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import IaKnowledgeService, { DuplicateKnowledgeEntryError, MissingCitationError } from '@deepseek-ai/dsh-ia-knowledge'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

async function makeKnowledge(config?: {
  minTemplates?: number
  minCases?: number
  maxSearchResults?: number
}): Promise<IaKnowledgeService> {
  context = new Context()
  await context.plugin(IaKnowledgeService, config)
  return context.iaKnowledge
}

const CASE_INPUT = {
  library: 'cases' as const,
  title: 'Interlock timeout mismatch',
  content: 'Simulation found the cylinder timeout parameter disagreeing with the requirement; repair raised it to 800 ms.',
  tags: ['interlock', 'timeout'],
  source: 'project-conveyor-01',
  version: 'v1.0',
  recordedBy: 'sim-agent',
  reviewStatus: 'pending-review' as const,
}

describe('IaKnowledgeService', () => {
  it('records an entry with its citation and a service-issued id', async () => {
    const knowledge = await makeKnowledge()
    const entry = knowledge.record(CASE_INPUT)
    expect(String(entry.id)).toBe('entry-1')
    expect(knowledge.entriesList('cases')).toEqual([entry])
  })

  it('rejects entries without a source or version citation', async () => {
    const knowledge = await makeKnowledge()
    expect(() => knowledge.record({ ...CASE_INPUT, source: '  ' })).toThrow(MissingCitationError)
    expect(() => knowledge.record({ ...CASE_INPUT, version: '' })).toThrow(MissingCitationError)
  })

  it('rejects empty titles, content, and recorder identities', async () => {
    const knowledge = await makeKnowledge()
    expect(() => knowledge.record({ ...CASE_INPUT, title: ' ' })).toThrow(/title/)
    expect(() => knowledge.record({ ...CASE_INPUT, content: '' })).toThrow(/content/)
    expect(() => knowledge.record({ ...CASE_INPUT, recordedBy: ' ' })).toThrow(/recordedBy/)
  })

  it('deduplicates identical title+content records per library', async () => {
    const knowledge = await makeKnowledge()
    knowledge.record(CASE_INPUT)
    expect(() => knowledge.record(CASE_INPUT)).toThrow(DuplicateKnowledgeEntryError)
    // The same title+content in another library is a different record.
    expect(() => knowledge.record({ ...CASE_INPUT, library: 'templates' })).not.toThrow()
  })

  it('searches deterministically: every term must match, hits carry citations', async () => {
    const knowledge = await makeKnowledge()
    knowledge.record(CASE_INPUT)
    knowledge.record({ ...CASE_INPUT, title: 'Start sequence freeze', content: 'The start button missed the rising edge.' })
    const result = knowledge.search('cases', 'timeout cylinder')
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]!.entry.source).toBe('project-conveyor-01')
    expect(result.hits[0]!.entry.version).toBe('v1.0')
    expect(result.hits[0]!.matchedTerms).toEqual(expect.arrayContaining(['timeout', 'cylinder']))
    expect(knowledge.search('cases', 'timeout pallet').hits).toEqual([])
    expect(knowledge.search('cases', '   ').hits).toEqual([])
  })

  it('caps retrieval at the configured maximum', async () => {
    const knowledge = await makeKnowledge({ maxSearchResults: 2 })
    for (let index = 0; index < 5; index++) {
      knowledge.record({ ...CASE_INPUT, title: `Timeout case ${index}` })
    }
    expect(knowledge.search('cases', 'timeout').hits).toHaveLength(2)
  })

  it('reports the cold-start readiness against configured minima', async () => {
    const knowledge = await makeKnowledge({ minTemplates: 20, minCases: 1 })
    expect(knowledge.readiness().ready).toBe(false)
    knowledge.record(CASE_INPUT)
    const readiness = knowledge.readiness()
    expect(readiness.ready).toBe(false)
    expect(readiness.counts.cases).toBe(1)
    expect(readiness.gaps).toEqual([{ library: 'templates', have: 0, need: 20 }])
  })

  it('flags retrieval results as degraded below cold-start scale', async () => {
    const knowledge = await makeKnowledge({ minCases: 5, minTemplates: 20 })
    knowledge.record(CASE_INPUT)
    expect(knowledge.search('cases', 'timeout').degraded).toBe(true)
  })

  it('fails loud on non-positive threshold config', async () => {
    context = new Context()
    await expect(context.plugin(IaKnowledgeService, { minCases: 0 })).rejects.toThrow(/positive integer/)
  })

  it('approves pending entries once and rejects double approval', async () => {
    const knowledge = await makeKnowledge()
    const entry = knowledge.record(CASE_INPUT)
    const approved = knowledge.approveEntry(entry.id)
    expect(approved.reviewStatus).toBe('approved')
    expect(() => knowledge.approveEntry(entry.id)).toThrow(/already approved/)
  })
})
