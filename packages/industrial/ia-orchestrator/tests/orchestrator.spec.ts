// Behavior of the orchestrator: DAG instantiation, verify-then-gate
// transitions, bounded inner-loop repair, escalation, and resolution.
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import IaGatesService, { GateId } from '@deepseek-ai/dsh-ia-gates'
import IaVerifiers from '@deepseek-ai/dsh-ia-verifier'
import IaOrchestratorService, { ProjectId, StageId, StageTransitionError, UnknownStageError } from '@deepseek-ai/dsh-ia-orchestrator'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

async function makeOrchestrator(gateLevel?: 'A0' | 'A1' | 'A2' | 'A3'): Promise<IaOrchestratorService> {
  context = new Context()
  await context.plugin(IaVerifiers)
  await context.plugin(IaGatesService, gateLevel === undefined ? {} : { level: gateLevel })
  await context.plugin(IaOrchestratorService)
  return context.iaOrchestrator
}

const GOOD_ST = `PROGRAM Conveyor
VAR
  Start : BOOL;
  Count : INT := 0;
END_VAR
IF Start THEN
  Count := Count + 1;
END_IF
END_PROGRAM`

const BAD_ST = 'PROGRAM Conveyor\nx := ;\nEND_PROGRAM'

/** Approve the latest pending gate request of one stage, then sync the project. */
function approveGate(orchestrator: IaOrchestratorService, projectId: ProjectId, stageId: StageId): void {
  const stage = orchestrator.project(projectId).stages.find(s => s.id === stageId)!
  const pending = context!.iaGates.requestsFor(stage.gate!).at(-1)!
  pending.decision = { outcome: 'approved', decider: 'human', rationale: 'ok', decidedAt: Date.now() }
  orchestrator.project(projectId)
}

/** Submit, approve, and advance through one gate-bound stage. */
async function passGateStage(orchestrator: IaOrchestratorService, projectId: ProjectId, stageId: StageId, nextStageId: StageId, text = 'artifact'): Promise<void> {
  await orchestrator.submit(projectId, stageId, { text, submittedBy: 'agent' })
  approveGate(orchestrator, projectId, stageId)
  orchestrator.advance(projectId, nextStageId)
}

describe('IaOrchestratorService', () => {
  it('instantiates the conveyor-line template with the first stage running', async () => {
    const orchestrator = await makeOrchestrator()
    const project = orchestrator.initProject()
    expect(project.template).toBe('conveyor-line')
    expect(project.stages.map(stage => String(stage.id))).toEqual([
      'requirements', 'design', 'control-program', 'simulation', 'commissioning', 'acceptance',
    ])
    expect(project.stages[0]!.state).toBe('running')
    expect(project.stages[1]!.state).toBe('pending')
  })

  it('rejects unknown templates at init', async () => {
    const orchestrator = await makeOrchestrator()
    expect(() => orchestrator.initProject(undefined, 'nope')).toThrow(/unknown template/)
  })

  it('keeps projects isolated by id', async () => {
    const orchestrator = await makeOrchestrator()
    const a = orchestrator.initProject(ProjectId('a'))
    const b = orchestrator.initProject(ProjectId('b'))
    expect(a.id).not.toBe(b.id)
    expect(orchestrator.projectsList()).toHaveLength(2)
  })

  it('rejects advancing before predecessors passed', async () => {
    const orchestrator = await makeOrchestrator()
    const project = orchestrator.initProject()
    expect(() => orchestrator.advance(project.id, StageId('design'))).toThrow(StageTransitionError)
  })

  it('gates a verified stage and reads the human decision back', async () => {
    const orchestrator = await makeOrchestrator()
    const project = orchestrator.initProject()
    // Requirements: no verifiers, gated by requirement-baseline.
    await orchestrator.submit(project.id, StageId('requirements'), { text: 'structured requirements', submittedBy: 'req-agent' })
    let snapshot = orchestrator.project(project.id)
    expect(snapshot.stages[0]!.state).toBe('gated')
    expect(snapshot.stages[0]!.gateStatus).toBe('pending')
    // The human approves through the gate engine.
    const pending = context!.iaGates.requestsFor(snapshot.stages[0]!.gate!).at(-1)!
    pending.decision = { outcome: 'approved', decider: 'human', rationale: 'ok', decidedAt: Date.now() }
    snapshot = orchestrator.project(project.id)
    expect(snapshot.stages[0]!.state).toBe('passed')
    orchestrator.advance(project.id, StageId('design'))
    expect(orchestrator.project(project.id).stages[1]!.state).toBe('running')
  })

  it('returns a rejected gate decision to running for rework', async () => {
    const orchestrator = await makeOrchestrator()
    const project = orchestrator.initProject()
    await orchestrator.submit(project.id, StageId('requirements'), { text: 'reqs', submittedBy: 'req-agent' })
    const pending = context!.iaGates.requestsFor(GateId('requirement-baseline')).at(-1)!
    pending.decision = { outcome: 'rejected', decider: 'human', rationale: 'incomplete', decidedAt: Date.now() }
    const snapshot = orchestrator.project(project.id)
    expect(snapshot.stages[0]!.state).toBe('running')
  })

  it('verifies a control-program submission before accepting it', async () => {
    const orchestrator = await makeOrchestrator()
    const project = orchestrator.initProject()
    await passGateStage(orchestrator, project.id, StageId('requirements'), StageId('design'))
    await passGateStage(orchestrator, project.id, StageId('design'), StageId('control-program'))
    const failing = await orchestrator.submit(project.id, StageId('control-program'), { text: BAD_ST, submittedBy: 'control-agent' })
    expect(failing.state).toBe('repair')
    expect(failing.attempts).toBe(1)
    const passing = await orchestrator.submit(project.id, StageId('control-program'), { text: GOOD_ST, submittedBy: 'control-agent' })
    expect(passing.state).toBe('passed')
  })

  it('escalates after the inner-loop budget is exhausted', async () => {
    const orchestrator = await makeOrchestrator()
    const project = orchestrator.initProject()
    await passGateStage(orchestrator, project.id, StageId('requirements'), StageId('design'))
    await passGateStage(orchestrator, project.id, StageId('design'), StageId('control-program'))
    for (let attempt = 0; attempt < 2; attempt++) {
      await orchestrator.submit(project.id, StageId('control-program'), { text: BAD_ST, submittedBy: 'control-agent' })
    }
    const escalated = await orchestrator.submit(project.id, StageId('control-program'), { text: BAD_ST, submittedBy: 'control-agent' })
    expect(escalated.state).toBe('escalated')
    expect(escalated.escalation).toBeDefined()
    expect(escalated.escalation?.reason).toContain('exhausted')
    expect(escalated.escalation?.failureSummary).toContain('st-syntax')
    expect(escalated.escalation?.options.length).toBeGreaterThan(0)
  })

  it('resolves an escalation with an instruction and a fresh budget', async () => {
    const orchestrator = await makeOrchestrator()
    const project = orchestrator.initProject()
    await passGateStage(orchestrator, project.id, StageId('requirements'), StageId('design'))
    await passGateStage(orchestrator, project.id, StageId('design'), StageId('control-program'))
    for (let attempt = 0; attempt < 3; attempt++) {
      await orchestrator.submit(project.id, StageId('control-program'), { text: BAD_ST, submittedBy: 'control-agent' })
    }
    const resolved = orchestrator.resolveEscalation(project.id, StageId('control-program'), 'fix the missing expression on line 2')
    expect(resolved.state).toBe('running')
    expect(resolved.attempts).toBe(0)
    expect(resolved.instruction).toContain('line 2')
    const snapshot = orchestrator.project(project.id)
    expect(snapshot.instructions[0]!.instruction).toContain('line 2')
  })

  it('rejects submissions from foreign states and unknown ids', async () => {
    const orchestrator = await makeOrchestrator()
    const project = orchestrator.initProject()
    await expect(orchestrator.submit(ProjectId('ghost'), StageId('design'), { text: 'x', submittedBy: 'me' })).rejects.toThrow(UnknownStageError)
    await expect(orchestrator.submit(project.id, StageId('ghost'), { text: 'x', submittedBy: 'me' })).rejects.toThrow(UnknownStageError)
    await expect(orchestrator.submit(project.id, StageId('design'), { text: 'x', submittedBy: 'me' })).rejects.toThrow(StageTransitionError)
    await expect(orchestrator.submit(project.id, StageId('requirements'), { text: '', submittedBy: 'me' })).rejects.toThrow(/non-empty/)
  })

  it('fails at load when the composed verifier registry lacks a bound kind', async () => {
    context = new Context()
    await context.plugin(IaVerifiers, { builtins: ['io-consistency'] })
    await context.plugin(IaGatesService)
    await expect(context.plugin(IaOrchestratorService)).rejects.toThrow(/binds unknown verifier "st-syntax"/)
  })

  it('runs the full conveyor loop to acceptance with gate approvals', async () => {
    const orchestrator = await makeOrchestrator()
    const project = orchestrator.initProject()
    const stageOrder = ['requirements', 'design', 'control-program', 'simulation', 'commissioning', 'acceptance']
    for (let index = 0; index < stageOrder.length; index++) {
      const stageId = stageOrder[index]!
      const text = stageId === 'control-program' ? GOOD_ST : `artifact of ${stageId}`
      await orchestrator.submit(project.id, StageId(stageId), { text, submittedBy: 'agent' })
      const stage = orchestrator.project(project.id).stages.find(s => String(s.id) === stageId)!
      if (stage.gate !== undefined) approveGate(orchestrator, project.id, StageId(stageId))
      if (index + 1 < stageOrder.length) {
        orchestrator.advance(project.id, StageId(stageOrder[index + 1]!))
      }
    }
    const snapshot = orchestrator.project(project.id)
    expect(snapshot.stages.every(stage => stage.state === 'passed')).toBe(true)
  })
})
