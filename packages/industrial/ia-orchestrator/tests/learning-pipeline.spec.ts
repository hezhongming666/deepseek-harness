/**
 * Learning pipeline (§4.3) and audit export (§5.4): a failure-repair pair
 * sediments one pending-review case with dedup, and the audit package carries
 * the complete gate request-and-decision history.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import IaGatesService from '@deepseek-ai/dsh-ia-gates'
import IaKnowledgeService from '@deepseek-ai/dsh-ia-knowledge'
import IaVerifiers from '@deepseek-ai/dsh-ia-verifier'
import IaOrchestratorService, { StageId } from '@deepseek-ai/dsh-ia-orchestrator'

const GOOD_ST = `PROGRAM Conveyor
VAR
  Start : BOOL;
END_VAR
END_PROGRAM`

const BAD_ST = 'PROGRAM Conveyor\nx := ;\nEND_PROGRAM'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

async function makeOrchestrator(withKnowledge: boolean): Promise<IaOrchestratorService> {
  context = new Context()
  await context.plugin(IaVerifiers)
  await context.plugin(IaGatesService)
  if (withKnowledge) await context.plugin(IaKnowledgeService)
  await context.plugin(IaOrchestratorService)
  return context.iaOrchestrator
}

async function walkToControlProgram(orchestrator: IaOrchestratorService): Promise<{ projectId: ReturnType<IaOrchestratorService['initProject']>['id'] }> {
  const project = orchestrator.initProject()
  for (const [from, to] of [['requirements', 'design'], ['design', 'control-program']] as const) {
    await orchestrator.submit(project.id, StageId(from), { text: 'artifact', submittedBy: 'agent' })
    const stage = orchestrator.project(project.id).stages.find(s => s.id === StageId(from))!
    const pending = context!.iaGates.requestsFor(stage.gate!).at(-1)!
    pending.decision = { outcome: 'approved', decider: 'human', rationale: 'ok', decidedAt: Date.now() }
    orchestrator.project(project.id)
    orchestrator.advance(project.id, StageId(to))
  }
  return { projectId: project.id }
}

describe('learning pipeline and audit export', () => {
  it('sediments one pending-review case per failure-repair pair, with dedup', async () => {
    const orchestrator = await makeOrchestrator(true)
    const { projectId } = await walkToControlProgram(orchestrator)
    const failing = await orchestrator.submit(projectId, StageId('control-program'), { text: BAD_ST, submittedBy: 'agent' })
    expect(failing.state).toBe('repair')
    const passing = await orchestrator.submit(projectId, StageId('control-program'), { text: GOOD_ST, submittedBy: 'agent' })
    expect(passing.state).toBe('passed')

    const cases = context!.iaKnowledge.entriesList('cases')
    expect(cases).toHaveLength(1)
    expect(cases[0]!.reviewStatus).toBe('pending-review')
    expect(cases[0]!.tags).toEqual(expect.arrayContaining(['learning-pipeline', 'failure-repair', 'control-program']))
    expect(cases[0]!.source).toBe(`project:${String(projectId)}`)
    expect(cases[0]!.content).toContain('st-syntax')

    // The identical pair in another project dedups through the sink's
    // duplicate rejection (library + title + content).
    const second = await walkToControlProgram(orchestrator)
    const failingAgain = await orchestrator.submit(second.projectId, StageId('control-program'), { text: BAD_ST, submittedBy: 'agent' })
    expect(failingAgain.state).toBe('repair')
    const passingAgain = await orchestrator.submit(second.projectId, StageId('control-program'), { text: GOOD_ST, submittedBy: 'agent' })
    expect(passingAgain.state).toBe('passed')
    expect(context!.iaKnowledge.entriesList('cases')).toHaveLength(1)
  })

  it('skips sedimentation silently when no knowledge service is mounted', async () => {
    const orchestrator = await makeOrchestrator(false)
    const { projectId } = await walkToControlProgram(orchestrator)
    await orchestrator.submit(projectId, StageId('control-program'), { text: BAD_ST, submittedBy: 'agent' })
    const passing = await orchestrator.submit(projectId, StageId('control-program'), { text: GOOD_ST, submittedBy: 'agent' })
    expect(passing.state).toBe('passed')
  })

  it('exports the audit package with the bound gate request-and-decision history', async () => {
    const orchestrator = await makeOrchestrator(false)
    const project = orchestrator.initProject()
    await orchestrator.submit(project.id, StageId('requirements'), { text: 'reqs', submittedBy: 'agent' })
    const stage = orchestrator.project(project.id).stages.find(s => s.id === StageId('requirements'))!
    const pending = context!.iaGates.requestsFor(stage.gate!).at(-1)!
    pending.decision = { outcome: 'approved', decider: 'human', rationale: 'ok', decidedAt: 42 }
    const audit = orchestrator.exportAudit(project.id)
    expect(audit.projectId).toBe(project.id)
    expect(audit.template).toBe('conveyor-line')
    expect(audit.stages).toHaveLength(6)
    const requirementRecord = audit.stages[0]!
    expect(requirementRecord.state).toBe('passed')
    expect(requirementRecord.gateRequests).toHaveLength(1)
    expect(requirementRecord.gateRequests[0]!.decision?.outcome).toBe('approved')
    expect(requirementRecord.gateRequests[0]!.decision?.decidedAt).toBe(42)
    expect(audit.stages[1]!.gateRequests).toEqual([])
  })
})
