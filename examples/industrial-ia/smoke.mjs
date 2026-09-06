/**
 * Keyless smoke for the industrial-automation overlay: boots the real Loader
 * over the six closed-loop rows, asserts the five tools register, and drives
 * one verification pass/fail pair plus a gate list and a project init — no
 * model call and no API key. A second boot adds the openness compile verifier
 * over a local fake bridge, proving the real-vendor channel end to end: the
 * `tia-compile` kind registers, adjudicates TIA SCL through the bridge wire
 * protocol, and joins the conveyor-line control-program verifier roster.
 *
 * Run from the repository root (tsconfig paths make workspace imports
 * resolve to source):
 *
 *   pnpm exec tsx examples/industrial-ia/smoke.mjs
 */
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import IaVerifiers from '@deepseek-ai/dsh-ia-verifier'
import IaGatesService from '@deepseek-ai/dsh-ia-gates'
import IaTraceService from '@deepseek-ai/dsh-ia-trace'
import IaKnowledgeService from '@deepseek-ai/dsh-ia-knowledge'
import IaOrchestratorService from '@deepseek-ai/dsh-ia-orchestrator'
import * as ToolIa from '@deepseek-ai/dsh-tool-ia'
import * as IaVerifierOpenness from '@deepseek-ai/dsh-ia-verifier-openness'

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

const GOOD_SCL = `FUNCTION "IACheck" : Void
{ S7_Optimized_Access := 'TRUE' }
VERSION : 0.1
BEGIN
END_FUNCTION`

const BAD_SCL = GOOD_SCL.replace('VERSION : 0.1', 'VERSION : 0.1\n(*FAIL*)')

const failures = []

function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

async function call(ctx, name, args) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`smoke-${name}`),
    name,
    arguments: args,
  })
}

/** Start a local fake Openness bridge replaying the FakeHost marker semantics. */
async function startFakeBridge() {
  const server = createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      const body = JSON.parse(raw)
      const errors = body.source.split('(*FAIL*)').length - 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        runId: body.runId,
        status: 'success',
        result: {
          compileErrors: errors,
          compileWarnings: 0,
          compileMs: 100,
          compileMessages: Array.from({ length: errors }, (_, index) => `fake error #${index + 1}`),
          compileMessageStates: Array.from({ length: errors }, () => 'error'),
          blockName: 'IACheck',
        },
      }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const url = `http://127.0.0.1:${address.port}`
  return {
    url,
    async close() {
      await new Promise((resolve, reject) => {
        server.close(error => error === undefined ? resolve() : reject(error))
      })
    },
  }
}

/** Boot the Loader over the given rows with the industrial module map. */
async function boot(rows) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ia-smoke-'))
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map([
    ['@deepseek-ai/dsh-ia-verifier', IaVerifiers],
    ['@deepseek-ai/dsh-ia-verifier-openness', IaVerifierOpenness],
    ['@deepseek-ai/dsh-ia-gates', IaGatesService],
    ['@deepseek-ai/dsh-ia-trace', IaTraceService],
    ['@deepseek-ai/dsh-ia-knowledge', IaKnowledgeService],
    ['@deepseek-ai/dsh-ia-orchestrator', IaOrchestratorService],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-ia', ToolIa],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  }
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, rows.join('\n'))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return { ctx, root }
}

const BASE_ROWS = [
  "- name: '@deepseek-ai/dsh-ia-verifier'",
  "- name: '@deepseek-ai/dsh-ia-gates'",
  "- name: '@deepseek-ai/dsh-ia-trace'",
  "- name: '@deepseek-ai/dsh-ia-knowledge'",
  "- name: '@deepseek-ai/dsh-ia-orchestrator'",
  "- name: '@deepseek-ai/dsh-system-prompt'",
  "- name: '@deepseek-ai/dsh-tools'",
  "- name: '@deepseek-ai/dsh-tool-ia'",
  '',
]

/** The base rows with per-service snapshot dataDirs under one root directory. */
function baseRows(dataDir, level) {
  if (dataDir === undefined) return BASE_ROWS
  const rows = ["- name: '@deepseek-ai/dsh-ia-verifier'"]
  for (const id of ['ia-gates', 'ia-trace', 'ia-knowledge', 'ia-orchestrator']) {
    const config = level === undefined
      ? [`    dataDir: ${join(dataDir, id.slice(3))}`]
      : id === 'ia-gates'
        ? ['    level: A2', `    dataDir: ${join(dataDir, id.slice(3))}`]
        : [`    dataDir: ${join(dataDir, id.slice(3))}`]
    rows.push(`- name: '@deepseek-ai/dsh-${id}'`, '  config:', ...config)
  }
  rows.push(
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-tool-ia'",
    '',
  )
  return rows
}

async function main() {
  {
    const { ctx, root } = await boot(BASE_ROWS)
    try {
      const names = ctx.tools.schemas().map(schema => schema.name)
      for (const expected of ['ia_verify', 'ia_trace', 'ia_gate', 'ia_knowledge', 'ia_project']) {
        check(`tool ${expected} registered`, names.includes(expected))
      }

      const verifyPass = await call(ctx, 'ia_verify', { kind: 'st-syntax', source: GOOD_ST })
      check('ia_verify passes a valid ST program', verifyPass.isError === false && verifyPass.value?.pass === true)

      const verifyFail = await call(ctx, 'ia_verify', { kind: 'st-syntax', source: BAD_ST })
      check('ia_verify fails an invalid ST program', verifyFail.isError === false && verifyFail.value?.pass === false)

      const gates = await call(ctx, 'ia_gate', { action: 'list' })
      const gateIds = (gates.value?.result?.gates ?? []).map(gate => gate.id)
      check(
        'ia_gate lists the six mandatory gates',
        ['requirement-baseline', 'design-review', 'sil-review', 'first-power-on', 'acceptance-signoff', 'online-change']
          .every(id => gateIds.includes(id)),
      )

      const project = await call(ctx, 'ia_project', { action: 'init' })
      check('ia_project instantiates the conveyor-line template', project.isError === false && project.value?.result?.template === 'conveyor-line')

      const gateSchema = ctx.tools.schemas().find(schema => schema.name === 'ia_gate')
      const action = (gateSchema?.parameters?.properties ?? {})['action']
      check('ia_gate schema exposes no decide action', !(action?.enum ?? []).includes('decide'))
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }

  {
    const bridge = await startFakeBridge()
    const rows = [
      ...BASE_ROWS.slice(0, -1),
      "- name: '@deepseek-ai/dsh-ia-verifier-openness'",
      '  config:',
      `    url: ${bridge.url}`,
      '',
    ]
    const { ctx, root } = await boot(rows)
    try {
      check('tia-compile joins the verifier registry', ctx.iaVerifiers.kinds().includes('tia-compile'))

      const verifyPass = await call(ctx, 'ia_verify', { kind: 'tia-compile', source: GOOD_SCL })
      check('ia_verify tia-compile passes clean TIA SCL', verifyPass.isError === false && verifyPass.value?.pass === true)

      const verifyFail = await call(ctx, 'ia_verify', { kind: 'tia-compile', source: BAD_SCL })
      check(
        'ia_verify tia-compile fails marked TIA SCL',
        verifyFail.isError === false
        && verifyFail.value?.pass === false
        && (verifyFail.value?.diagnostics ?? []).some(diagnostic => diagnostic.code === 'tia-compile-error'),
      )

      const project = ctx.iaOrchestrator.initProject()
      const stage = project.stages.find(entry => entry.id === 'control-program')
      check(
        'conveyor-line binds tia-compile as an optional control-program verifier',
        (stage?.verifiers ?? []).includes('tia-compile'),
      )

      // Drive the full stage chain: local checks read the harness-dialect
      // text, the real compile reads the TIA SCL vendorSource.
      const approveGate = (projectId, stageId) => {
        const snapshot = ctx.iaOrchestrator.project(projectId)
        const pending = ctx.iaGates.requestsFor(snapshot.stages.find(entry => entry.id === stageId).gate).at(-1)
        pending.decision = { outcome: 'approved', decider: 'human', rationale: 'ok', decidedAt: Date.now() }
        ctx.iaOrchestrator.project(projectId)
      }
      const walk = async (from, to) => {
        await ctx.iaOrchestrator.submit(project.id, from, { text: 'artifact', submittedBy: 'smoke' })
        approveGate(project.id, from)
        ctx.iaOrchestrator.advance(project.id, to)
      }
      await walk('requirements', 'design')
      await walk('design', 'control-program')

      const failing = await ctx.iaOrchestrator.submit(project.id, 'control-program', {
        text: BAD_ST,
        vendorSource: BAD_SCL,
        submittedBy: 'smoke',
      })
      check('control-program stage repairs a submission that fails local and vendor checks', failing.state === 'repair')
      const failingReports = failing.reports ?? []
      check(
        'repair carries failing st-syntax and tia-compile reports',
        failingReports.some(report => report.kind === 'st-syntax' && report.pass === false)
        && failingReports.some(report => report.kind === 'tia-compile' && report.pass === false),
      )

      const passing = await ctx.iaOrchestrator.submit(project.id, 'control-program', {
        text: GOOD_ST,
        vendorSource: GOOD_SCL,
        submittedBy: 'smoke',
      })
      check('control-program stage passes when both local checks and the real compile pass', passing.state === 'passed')
      check(
        'passed stage holds a passing tia-compile report',
        (passing.reports ?? []).some(report => report.kind === 'tia-compile' && report.pass === true),
      )
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
      await bridge.close()
    }
  }

  {
    // Persistence round-trip over the assembled composition: state written in
    // one boot must survive a fresh boot against the same data directories.
    const data = await mkdtemp(join(tmpdir(), 'dsh-ia-smoke-data-'))
    const first = await boot(baseRows(data, 'A2'))
    let restored = undefined
    try {
      // The A2 auto-release rule decides through the real service path, so
      // the decision itself is what persistence must restore.
      first.ctx.iaGates.registerAutoReleaseRule('smoke-rule', 'requirement-baseline', () => true)
      const project = await call(first.ctx, 'ia_project', { action: 'init' })
      const projectId = project.value?.result?.id
      await call(first.ctx, 'ia_project', { action: 'submit', projectId, stageId: 'requirements', text: '持久化需求' })
      first.ctx.iaOrchestrator.project(projectId)
      await call(first.ctx, 'ia_knowledge', {
        action: 'record', library: 'cases', title: '持久化探针案例', content: 'restart round-trip probe',
        source: 'smoke', version: 'v1',
      })
      first.ctx.iaTrace.project('smoke-scope').addNode({ kind: 'requirement', title: 'R-持久化', author: 'smoke' })
      await first.ctx.fiber.dispose()
      await rm(first.root, { recursive: true, force: true })

      restored = await boot(baseRows(data, 'A2'))
      check('restart restores the orchestrator project with its gate decision',
        restored.ctx.iaOrchestrator.projectsList().some(entry => String(entry.id) === projectId)
        && restored.ctx.iaOrchestrator.project(projectId).stages.find(entry => entry.id === 'requirements').state === 'passed')
      check('restart restores the gate decision history',
        restored.ctx.iaGates.latestDecision('requirement-baseline')?.outcome === 'approved'
        && restored.ctx.iaGates.latestDecision('requirement-baseline')?.decider === 'rule:smoke-rule')
      check('restart restores knowledge entries',
        restored.ctx.iaKnowledge.search('cases', 'restart').hits.length === 1)
      check('restart restores the scoped trace graph',
        restored.ctx.iaTrace.hasProject('smoke-scope')
        && restored.ctx.iaTrace.project('smoke-scope').nodesList().length === 1)
    } finally {
      await restored?.ctx.fiber.dispose()
      if (restored?.root !== undefined) await rm(restored.root, { recursive: true, force: true })
      await rm(data, { recursive: true, force: true })
    }
  }

  if (failures.length > 0) {
    console.error(`\nsmoke failed: ${failures.join('; ')}`)
    process.exitCode = 1
  } else {
    console.log('\nindustrial-ia smoke: all checks passed.')
  }
}

await main()
