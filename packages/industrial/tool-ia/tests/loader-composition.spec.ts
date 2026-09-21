// Proves the tools compose through a real cordis.yml Loader boot over the
// industrial services: schemas register, verify/trace/knowledge/project
// execute without an agent, and the gate tool keeps its request-only surface.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import IaVerifiers from '@deepseek-ai/dsh-ia-verifier'
import IaGatesService from '@deepseek-ai/dsh-ia-gates'
import IaTraceService from '@deepseek-ai/dsh-ia-trace'
import IaKnowledgeService from '@deepseek-ai/dsh-ia-knowledge'
import IaOrchestratorService from '@deepseek-ai/dsh-ia-orchestrator'
import * as ToolIa from '@deepseek-ai/dsh-tool-ia'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-tool-ia-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-ia-verifier'",
    "- name: '@deepseek-ai/dsh-ia-gates'",
    "- name: '@deepseek-ai/dsh-ia-trace'",
    "- name: '@deepseek-ai/dsh-ia-knowledge'",
    "- name: '@deepseek-ai/dsh-ia-orchestrator'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-tool-ia'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-ia-verifier', IaVerifiers],
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
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

async function call(ctx: Context, name: string, args: Record<string, unknown>, agent?: Agent) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`tool-ia-${name}`),
    name,
    arguments: args,
    ...(agent !== undefined ? { agent } : {}),
  })
}

/** Read the joined text of one tool result's content blocks. */
function contentText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
}

describe('tool-ia real Loader composition through cordis.yml', () => {
  it('registers the five tools with schemas', async () => {
    const ctx = await boot()
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toEqual(expect.arrayContaining(['ia_verify', 'ia_trace', 'ia_gate', 'ia_knowledge', 'ia_project']))
  })

  it('ia_verify runs the deterministic syntax check', async () => {
    const ctx = await boot()
    const result = await call(ctx, 'ia_verify', {
      kind: 'st-syntax',
      source: 'PROGRAM Main\nEND_PROGRAM',
    })
    expect(result.isError).toBe(false)
    expect(result.value).toEqual(expect.objectContaining({ kind: 'st-syntax', pass: true }))
  })

  it('ia_verify fails loud on an unregistered kind', async () => {
    const ctx = await boot()
    const result = await call(ctx, 'ia_verify', { kind: 'nope', source: 'x' })
    expect(result.isError).toBe(true)
  })

  it('ia_trace records and links nodes without an agent-scope error path', async () => {
    const ctx = await boot()
    const result = await call(ctx, 'ia_trace', { action: 'record', kind: 'requirement', title: 'R1' })
    expect(result.isError).toBe(true)
  })

  it('ia_trace renders issued node ids, links, and the coverage matrix for the calling agent', async () => {
    const ctx = await boot()
    const agent = { id: 'agent-1', session: { id: 'session-1' } } as unknown as Agent
    const requirement = await call(ctx, 'ia_trace', { action: 'record', kind: 'requirement', title: 'R1' }, agent)
    expect(requirement.isError).toBe(false)
    expect(contentText(requirement)).toBe('Trace requirement recorded: node-1 — R1')
    const implementation = await call(ctx, 'ia_trace', { action: 'record', kind: 'implementation', title: 'IMP-1' }, agent)
    expect(contentText(implementation)).toBe('Trace implementation recorded: node-2 — IMP-1')
    const link = await call(ctx, 'ia_trace', { action: 'link', from: 'node-1', to: 'node-2', linkKind: 'implements' }, agent)
    expect(link.isError).toBe(false)
    expect(contentText(link)).toBe('Trace link: node-1 -implements-> node-2')
    const matrix = await call(ctx, 'ia_trace', { action: 'matrix' }, agent)
    expect(matrix.isError).toBe(false)
    expect(contentText(matrix)).toContain('node-1 R1: implementations=[node-2] tests=[] covered=false')
  })

  it('ia_knowledge records, searches with citations, and reports readiness', async () => {
    const ctx = await boot()
    const record = await call(ctx, 'ia_knowledge', {
      action: 'record',
      library: 'cases',
      title: 'Timeout case',
      content: 'cylinder timeout mismatch',
      source: 'proj-1',
      version: 'v1',
    })
    expect(record.isError).toBe(false)
    expect(contentText(record)).toBe('Knowledge recorded: entry-1 (pending-review)')
    const search = await call(ctx, 'ia_knowledge', { action: 'search', library: 'cases', query: 'timeout' })
    expect(contentText(search)).toContain('Knowledge search: 1 hit(s) — degraded: libraries below cold-start minimum')
    expect(contentText(search)).toContain('source: proj-1 version: v1 (pending-review)')
    const searchResult = (search.value as { result: { hits: { entry: { source: string; version: string } }[]; degraded: boolean } }).result
    expect(searchResult.degraded).toBe(true)
    expect(searchResult.hits).toHaveLength(1)
    expect(searchResult.hits[0]?.entry.source).toBe('proj-1')
    expect(searchResult.hits[0]?.entry.version).toBe('v1')
    const readiness = await call(ctx, 'ia_knowledge', { action: 'readiness' })
    expect(contentText(readiness)).toContain('Knowledge readiness: not ready')
    expect((readiness.value as { result: { ready: boolean } }).result.ready).toBe(false)
  })

  it('ia_project instantiates the conveyor template and reports status', async () => {
    const ctx = await boot()
    const init = await call(ctx, 'ia_project', { action: 'init' })
    expect(init.isError).toBe(false)
    expect(contentText(init)).toContain('Project project-1 (conveyor-line):')
    expect(contentText(init)).toContain('requirements [running]')
    const projectId = (init.value as { result: { id: string } }).result.id
    const status = await call(ctx, 'ia_project', { action: 'status', projectId })
    expect(contentText(status)).toContain('Project project-1 (conveyor-line):')
    const statusResult = (status.value as { result: { template: string; stages: { id: string; state: string }[] } }).result
    expect(statusResult.template).toBe('conveyor-line')
    const firstStage = statusResult.stages.find(stage => stage.id === 'requirements')
    expect(firstStage?.state).toBe('running')
    const list = await call(ctx, 'ia_project', { action: 'list' })
    expect(contentText(list)).toContain(`- ${projectId} (conveyor-line)`)
    const exported = await call(ctx, 'ia_project', { action: 'export', projectId })
    expect(exported.isError).toBe(false)
    expect(contentText(exported)).toContain(`Audit exported: project=${projectId} (conveyor-line)`)
    expect(contentText(exported)).toContain('requirements [running]')
  })

  it('ia_gate lists the mandatory gates and keeps its schema request-only', async () => {
    const ctx = await boot()
    const list = await call(ctx, 'ia_gate', { action: 'list' })
    expect(list.isError).toBe(false)
    const listText = contentText(list)
    expect(listText).toContain('- requirement-baseline: Requirement baseline confirmation')
    expect(listText).toContain('- first-power-on [always-human]: First power-on and energized actions')
    const gates = list.value as { result: { gates: { id: string; alwaysHuman: boolean }[] } }
    expect(gates.result.gates.map(gate => gate.id)).toEqual(expect.arrayContaining([
      'requirement-baseline', 'design-review', 'sil-review', 'first-power-on', 'acceptance-signoff', 'online-change',
    ]))
    const schema = ctx.tools.schemas().find(entry => entry.name === 'ia_gate')!
    const action = (schema.parameters?.properties as Record<string, { enum?: readonly string[] }> | undefined)?.['action']
    expect(action?.enum ?? []).not.toContain('decide')
  })

  it('ia_gate request without an agent stays pending and says so', async () => {
    const ctx = await boot()
    const result = await call(ctx, 'ia_gate', { action: 'request', gateId: 'design-review', reason: 'test' })
    expect(result.isError).toBe(false)
    expect(contentText(result)).toContain('Gate design-review: pending')
    expect(contentText(result)).toContain('no owning agent session')
    const gateResult = (result.value as { result: { decided: boolean; outcome: string } }).result
    expect(gateResult.decided).toBe(false)
    expect(gateResult.outcome).toBe('pending')
  })
})
