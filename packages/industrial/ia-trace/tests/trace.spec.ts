// Behavior of the traceability service: append-only graph, change records,
// three-level impact analysis, matrices, and per-scope isolation.
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import IaTraceService, { TraceNodeId, DuplicateTraceLinkError, UnknownTraceNodeError } from '@deepseek-ai/dsh-ia-trace'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

async function makeTrace(): Promise<IaTraceService> {
  context = new Context()
  await context.plugin(IaTraceService)
  return context.iaTrace
}

/** A small conveyor requirement→design→implementation→test graph. */
function seedConveyor(service: IaTraceService) {
  const project = service.project('conveyor')
  const requirement = project.addNode({
    kind: 'requirement',
    title: 'REQ-01 conveyor starts on request',
    author: 'requirement-agent',
    tags: ['conveyor', 'start'],
    basis: 'URS §3.1',
  })
  const design = project.addNode({
    kind: 'design',
    title: 'DES-01 start interlock chain',
    author: 'design-agent',
    tags: ['conveyor'],
  })
  const implementation = project.addNode({
    kind: 'implementation',
    title: 'PLC-01 control program',
    author: 'control-agent',
    tags: ['conveyor'],
  })
  const test = project.addNode({
    kind: 'test',
    title: 'TC-01 start sequence',
    author: 'sim-agent',
    tags: ['conveyor', 'start'],
  })
  project.addLink(requirement.id, design.id, 'derives')
  project.addLink(design.id, implementation.id, 'implements')
  project.addLink(implementation.id, test.id, 'verifies')
  return { project, requirement, design, implementation, test }
}

describe('IaTraceService', () => {
  it('records nodes with service-issued ids in order', async () => {
    const service = await makeTrace()
    const project = service.project('p')
    const first = project.addNode({ kind: 'requirement', title: 'a', author: 'me' })
    const second = project.addNode({ kind: 'test', title: 'b', author: 'me' })
    expect(String(first.id)).toBe('node-1')
    expect(String(second.id)).toBe('node-2')
    expect(project.nodesList()).toHaveLength(2)
  })

  it('rejects a node with an empty title or author', async () => {
    const service = await makeTrace()
    const project = service.project('p')
    expect(() => project.addNode({ kind: 'requirement', title: '  ', author: 'me' })).toThrow(/title/)
    expect(() => project.addNode({ kind: 'requirement', title: 'ok', author: ' ' })).toThrow(/author/)
  })

  it('rejects links to unknown nodes and duplicate edges', async () => {
    const service = await makeTrace()
    const project = service.project('p')
    const a = project.addNode({ kind: 'requirement', title: 'a', author: 'me' })
    const b = project.addNode({ kind: 'design', title: 'b', author: 'me' })
    expect(() => project.addLink(TraceNodeId('node-99'), b.id, 'derives')).toThrow(UnknownTraceNodeError)
    expect(() => project.addLink(a.id, TraceNodeId('node-99'), 'derives')).toThrow(UnknownTraceNodeError)
    project.addLink(a.id, b.id, 'derives')
    expect(() => project.addLink(a.id, b.id, 'derives')).toThrow(DuplicateTraceLinkError)
  })

  it('separates projects by scope key', async () => {
    const service = await makeTrace()
    const a = service.project('project-a')
    const b = service.project('project-b')
    a.addNode({ kind: 'requirement', title: 'only in a', author: 'me' })
    expect(a.nodesList()).toHaveLength(1)
    expect(b.nodesList()).toHaveLength(0)
    expect(service.hasProject('project-a')).toBe(true)
    expect(service.hasProject('project-b')).toBe(true)
  })

  it('reuses one project per scope and notifies open listeners once', async () => {
    const service = await makeTrace()
    const opens: string[] = []
    service.onProjectOpen((project) => { opens.push(project.nodesList().length.toString()) })
    service.project('p')
    service.project('p')
    service.project('q')
    expect(opens).toEqual(['0', '0'])
  })

  it('computes three-level impact: direct, indirect, and tag-sharing potential', async () => {
    const service = await makeTrace()
    const { project, requirement, design, implementation, test } = seedConveyor(service)
    const unrelated = project.addNode({
      kind: 'requirement',
      title: 'REQ-02 pallet stop',
      author: 'me',
      tags: ['start'],
    })
    const impact = project.impactOf([requirement.id])
    expect(impact.changed).toEqual([requirement.id])
    expect(impact.direct).toEqual([design.id])
    expect(impact.indirect).toHaveLength(2)
    expect(impact.indirect).toContain(implementation.id)
    expect(impact.indirect).toContain(test.id)
    // The unrelated requirement shares the `start` tag but is unreachable.
    expect(impact.potential).toContain(unrelated.id)
  })

  it('keeps potential impacts out of direct and indirect sets', async () => {
    const service = await makeTrace()
    const project = service.project('p')
    const a = project.addNode({ kind: 'requirement', title: 'a', author: 'me', tags: ['t'] })
    const b = project.addNode({ kind: 'design', title: 'b', author: 'me', tags: ['t'] })
    project.addLink(a.id, b.id, 'derives')
    const impact = project.impactOf([a.id])
    expect(impact.direct).toEqual([b.id])
    expect(impact.indirect).toEqual([])
    expect(impact.potential).toEqual([])
  })

  it('recordChange bumps change versions, appends the record, and returns the impact', async () => {
    const service = await makeTrace()
    const { project, design } = seedConveyor(service)
    const { record, impact } = project.recordChange({
      nodeIds: [design.id],
      author: 'human-supervisor',
      reason: 'interlock timeout wrong',
    })
    expect(project.node(design.id)!.changeVersion).toBe(1)
    expect(project.changesList()).toEqual([record])
    expect(impact.changed).toEqual([design.id])
    expect(impact.direct.length).toBeGreaterThan(0)
  })

  it('rejects a change without nodes, with unknown nodes, or without an author', async () => {
    const service = await makeTrace()
    const project = service.project('p')
    const a = project.addNode({ kind: 'requirement', title: 'a', author: 'me' })
    expect(() => project.recordChange({ nodeIds: [], author: 'me', reason: 'x' })).toThrow(/at least one node/)
    expect(() => project.recordChange({ nodeIds: [TraceNodeId('node-9')], author: 'me', reason: 'x' })).toThrow(UnknownTraceNodeError)
    expect(() => project.recordChange({ nodeIds: [a.id], author: '  ', reason: 'x' })).toThrow(/author/)
  })

  it('projects the requirement matrix with coverage verdicts', async () => {
    const service = await makeTrace()
    const { project, requirement } = seedConveyor(service)
    const bare = project.addNode({ kind: 'requirement', title: 'REQ-03 untested', author: 'me' })
    const rows = project.matrix()
    expect(rows).toHaveLength(2)
    const coveredRow = rows.find(row => row.requirement.id === requirement.id)!
    expect(coveredRow.covered).toBe(true)
    expect(coveredRow.implementations.map(node => node.kind)).toEqual(['implementation'])
    expect(coveredRow.tests.map(node => node.kind)).toEqual(['test'])
    const bareRow = rows.find(row => row.requirement.id === bare.id)!
    expect(bareRow.covered).toBe(false)
    expect(bareRow.implementations).toEqual([])
  })
})
