/**
 * Real Loader composition through a test-only cordis.yml: the openness
 * compile verifier registers `tia-compile` next to the built-in verifiers,
 * the conveyor-line template picks it up as an optional control-program
 * verifier when registered, and a submission runs the fake bridge alongside
 * the local st-syntax/st-lint checks. A second boot without the plugin proves
 * the optional slot stays silent when nothing registers it.
 */

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import IaVerifiers from '@deepseek-ai/dsh-ia-verifier'
import IaGatesService from '@deepseek-ai/dsh-ia-gates'
import IaOrchestratorService, { ProjectId, StageId } from '@deepseek-ai/dsh-ia-orchestrator'
import * as IaVerifierOpenness from '@deepseek-ai/dsh-ia-verifier-openness'

/** A fake Openness bridge replaying the FakeHost marker semantics. */
interface FakeBridge {
  url: string
  requests: number
  close(): Promise<void>
}

async function startFakeBridge(): Promise<FakeBridge> {
  let requests = 0
  const server = createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: Buffer | string) => { raw += typeof chunk === 'string' ? chunk : chunk.toString() })
    request.on('end', () => {
      requests += 1
      const body = JSON.parse(raw) as { runId: string; source: string }
      const errors = body.source.split('(*FAIL*)').length - 1
      const warnings = body.source.split('(*WARN*)').length - 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        runId: body.runId,
        status: 'success',
        result: {
          compileErrors: errors,
          compileWarnings: warnings,
          compileMs: 100,
          compileMessages: [
            ...Array.from({ length: errors }, (_, index) => `fake error #${index + 1}`),
            ...Array.from({ length: warnings }, (_, index) => `fake warning #${index + 1}`),
          ],
          compileMessageStates: [
            ...Array.from({ length: errors }, () => 'error'),
            ...Array.from({ length: warnings }, () => 'warning'),
          ],
          blockName: 'IACheck',
        },
      }))
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}`,
    get requests() { return requests },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve()
          else reject(error)
        })
      })
    },
  }
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

const GOOD_SCL = 'FUNCTION "IACheck" : Void\nBEGIN\nEND_FUNCTION'
const BAD_SCL = GOOD_SCL.replace('BEGIN', 'BEGIN\n(*FAIL*)')

let root: string | undefined
let context: Context | undefined
let bridge: FakeBridge | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  await bridge?.close()
  bridge = undefined
})

async function boot(includeOpenness: boolean): Promise<Context> {
  bridge = await startFakeBridge()
  root = await mkdtemp(join(tmpdir(), 'dsh-ia-verifier-openness-loader-'))
  const configPath = join(root, 'cordis.yml')
  const rows = [
    "- name: '@deepseek-ai/dsh-ia-verifier'",
    ...(includeOpenness
      ? [
        "- name: '@deepseek-ai/dsh-ia-verifier-openness'",
        '  config:',
        `    url: ${bridge.url}`,
      ]
      : []),
    "- name: '@deepseek-ai/dsh-ia-gates'",
    "- name: '@deepseek-ai/dsh-ia-orchestrator'",
    '',
  ]
  await writeFile(configPath, rows.join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-ia-verifier', IaVerifiers],
    ['@deepseek-ai/dsh-ia-verifier-openness', IaVerifierOpenness],
    ['@deepseek-ai/dsh-ia-gates', IaGatesService],
    ['@deepseek-ai/dsh-ia-orchestrator', IaOrchestratorService],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

/** Approve the latest pending gate request of one stage, then sync the project. */
function approveGate(orchestrator: IaOrchestratorService, projectId: ProjectId, stageId: StageId): void {
  const stage = orchestrator.project(projectId).stages.find(s => s.id === stageId)!
  const pending = context!.iaGates.requestsFor(stage.gate!).at(-1)!
  pending.decision = { outcome: 'approved', decider: 'human', rationale: 'ok', decidedAt: Date.now() }
  orchestrator.project(projectId)
}

/** Submit, approve, and advance through one gate-bound stage. */
async function passGateStage(
  orchestrator: IaOrchestratorService,
  projectId: ProjectId,
  stageId: StageId,
  nextStageId: StageId,
): Promise<void> {
  await orchestrator.submit(projectId, stageId, { text: 'artifact', submittedBy: 'agent' })
  approveGate(orchestrator, projectId, stageId)
  orchestrator.advance(projectId, nextStageId)
}

describe('ia-verifier-openness real Loader composition', () => {
  it('registers tia-compile and the conveyor template binds it as an optional control-program verifier', async () => {
    const ctx = await boot(true)
    expect(ctx.iaVerifiers.kinds()).toEqual(expect.arrayContaining(['st-syntax', 'st-lint', 'tia-compile']))
    const project = ctx.iaOrchestrator.initProject()
    const stage = project.stages.find(s => s.id === StageId('control-program'))!
    expect(stage.verifiers).toEqual(['st-syntax', 'st-lint', 'tia-compile'])
  })

  it('runs the real bridge verdict alongside the local checks on submission', async () => {
    const ctx = await boot(true)
    const orchestrator = ctx.iaOrchestrator
    const project = orchestrator.initProject()
    await passGateStage(orchestrator, project.id, StageId('requirements'), StageId('design'))
    await passGateStage(orchestrator, project.id, StageId('design'), StageId('control-program'))

    const failing = await orchestrator.submit(project.id, StageId('control-program'), {
      text: BAD_ST,
      vendorSource: BAD_SCL,
      submittedBy: 'control-agent',
    })
    expect(failing.state).toBe('repair')
    const failingStage = orchestrator.project(project.id).stages.find(s => s.id === StageId('control-program'))!
    const compile = failingStage.reports?.find(report => report.kind === 'tia-compile')
    expect(compile?.pass).toBe(false)
    expect(compile?.diagnostics.map(diagnostic => diagnostic.code)).toContain('tia-compile-error')
    const local = failingStage.reports?.find(report => report.kind === 'st-syntax')
    expect(local?.pass).toBe(false)
    expect(bridge!.requests).toBe(1)

    const passing = await orchestrator.submit(project.id, StageId('control-program'), {
      text: GOOD_ST,
      vendorSource: GOOD_SCL,
      submittedBy: 'control-agent',
    })
    expect(passing.state).toBe('passed')
    const passingStage = orchestrator.project(project.id).stages.find(s => s.id === StageId('control-program'))!
    const passingCompile = passingStage.reports?.find(report => report.kind === 'tia-compile')
    expect(passingCompile?.pass).toBe(true)
    expect(passingCompile?.diagnostics).toEqual([])
    expect(bridge!.requests).toBe(2)
  })

  it('leaves the optional slot empty when no openness verifier is mounted', async () => {
    const ctx = await boot(false)
    expect(ctx.iaVerifiers.kinds()).toEqual(['st-syntax', 'st-lint', 'io-consistency'])
    const project = ctx.iaOrchestrator.initProject()
    const stage = project.stages.find(s => s.id === StageId('control-program'))!
    expect(stage.verifiers).toEqual(['st-syntax', 'st-lint'])
    await passGateStage(ctx.iaOrchestrator, project.id, StageId('requirements'), StageId('design'))
    await passGateStage(ctx.iaOrchestrator, project.id, StageId('design'), StageId('control-program'))
    const passed = await ctx.iaOrchestrator.submit(project.id, StageId('control-program'), { text: GOOD_ST, submittedBy: 'control-agent' })
    expect(passed.state).toBe('passed')
    expect(bridge!.requests).toBe(0)
  })
})
