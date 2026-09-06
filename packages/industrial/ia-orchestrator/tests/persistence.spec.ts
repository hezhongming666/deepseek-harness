/**
 * Orchestrator persistence: project stage machines written to `dataDir`
 * survive a restart, fresh directories start clean, and corrupt or
 * wrong-version snapshots fail loud at load.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import IaGatesService from '@deepseek-ai/dsh-ia-gates'
import IaVerifiers from '@deepseek-ai/dsh-ia-verifier'
import IaOrchestratorService, { ProjectId, StageId } from '@deepseek-ai/dsh-ia-orchestrator'

const GOOD_ST = `PROGRAM Conveyor
VAR
  Start : BOOL;
END_VAR
END_PROGRAM`

const BAD_ST = 'PROGRAM Conveyor\nx := ;\nEND_PROGRAM'

let dir: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function dataDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'dsh-ia-orchestrator-data-'))
  return dir
}

async function makeOrchestrator(config: { dataDir?: string } = {}): Promise<IaOrchestratorService> {
  context = new Context()
  await context.plugin(IaVerifiers)
  await context.plugin(IaGatesService)
  await context.plugin(IaOrchestratorService, config)
  return context.iaOrchestrator
}

/** Approve the latest pending gate request of one stage, then sync the project. */
function approveGate(orchestrator: IaOrchestratorService, projectId: ProjectId, stageId: StageId): void {
  const stage = orchestrator.project(projectId).stages.find(s => s.id === stageId)!
  const pending = context!.iaGates.requestsFor(stage.gate!).at(-1)!
  pending.decision = { outcome: 'approved', decider: 'human', rationale: 'ok', decidedAt: Date.now() }
  orchestrator.project(projectId)
}

describe('ia-orchestrator persistence', () => {
  it('restores projects, stage machines, gate sync, and the ordinal across restarts', async () => {
    const dir = dataDir()
    let orchestrator = await makeOrchestrator({ dataDir: dir })
    const project = orchestrator.initProject()
    await orchestrator.submit(project.id, StageId('requirements'), { text: 'reqs', submittedBy: 'agent' })
    approveGate(orchestrator, project.id, StageId('requirements'))
    expect(orchestrator.project(project.id).stages[0]!.state).toBe('passed')
    orchestrator.advance(project.id, StageId('design'))
    await orchestrator.submit(project.id, StageId('design'), { text: 'design', submittedBy: 'agent' })
    await context!.fiber.dispose()
    context = undefined

    orchestrator = await makeOrchestrator({ dataDir: dir })
    const restored = orchestrator.project(project.id)
    expect(restored.template).toBe('conveyor-line')
    expect(restored.stages.map(stage => stage.state)).toEqual(['passed', 'gated', 'pending', 'pending', 'pending', 'pending'])
    // The design stage still folds its restored pending decision on read.
    expect(restored.stages[1]!.gateStatus).toBe('pending')
    // The ordinal survived, so fresh project ids never collide with restored ones.
    const fresh = orchestrator.initProject()
    expect(fresh.id).not.toBe(project.id)
  })

  it('restores a repair state with its reports and attempts', async () => {
    const dir = dataDir()
    let orchestrator = await makeOrchestrator({ dataDir: dir })
    const project = orchestrator.initProject()
    await orchestrator.submit(project.id, StageId('requirements'), { text: 'reqs', submittedBy: 'agent' })
    approveGate(orchestrator, project.id, StageId('requirements'))
    orchestrator.advance(project.id, StageId('design'))
    await orchestrator.submit(project.id, StageId('design'), { text: 'design', submittedBy: 'agent' })
    approveGate(orchestrator, project.id, StageId('design'))
    orchestrator.advance(project.id, StageId('control-program'))
    const failing = await orchestrator.submit(project.id, StageId('control-program'), { text: BAD_ST, submittedBy: 'agent' })
    expect(failing.state).toBe('repair')
    await context!.fiber.dispose()
    context = undefined

    orchestrator = await makeOrchestrator({ dataDir: dir })
    const stage = orchestrator.project(project.id).stages.find(s => s.id === StageId('control-program'))!
    expect(stage.state).toBe('repair')
    expect(stage.attempts).toBe(1)
    expect(stage.reports?.some(report => report.kind === 'st-syntax' && !report.pass)).toBe(true)
    // The restored repair state still accepts the fixed submission.
    const passing = await orchestrator.submit(project.id, StageId('control-program'), { text: GOOD_ST, submittedBy: 'agent' })
    expect(passing.state).toBe('passed')
  })

  it('starts clean on a fresh data directory', async () => {
    const orchestrator = await makeOrchestrator({ dataDir: dataDir() })
    expect(orchestrator.projectsList()).toEqual([])
  })

  it('fails loud on a malformed snapshot', async () => {
    const dir = dataDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'ia-orchestrator.json'), '{not json')
    await expect(makeOrchestrator({ dataDir: dir })).rejects.toThrow(/malformed JSON/)
  })

  it('fails loud on a wrong snapshot version', async () => {
    const dir = dataDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'ia-orchestrator.json'), JSON.stringify({ version: 99, state: {} }))
    await expect(makeOrchestrator({ dataDir: dir })).rejects.toThrow(/format version 99, expected 1/)
  })

  it('fails loud when the snapshot write fails after the memory commit', async () => {
    const dir = dataDir()
    const orchestrator = await makeOrchestrator({ dataDir: dir })
    // A directory squatting on the snapshot path makes the atomic rename fail.
    mkdirSync(join(dir, 'ia-orchestrator.json'), { recursive: true })
    expect(() => orchestrator.initProject()).toThrow(/committed in memory but the snapshot write failed/)
    expect(orchestrator.projectsList()).toHaveLength(1)
  })
})
