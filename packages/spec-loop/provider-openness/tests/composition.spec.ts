// Proves the provider composes through a real cordis.yml Loader boot: the
// provider registers ctx.specLoopAdapter, the spec_loop tool resolves it from
// the composed service store, and a satisfying initial-candidate run
// completes against the fake bridge without any LLM call.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolSpecLoop from '@deepseek-ai/dsh-tool-spec-loop'
import OpennessSpecLoopAdapter from '../src/index.ts'
import { startFakeBridge } from './fake-bridge.ts'
import type { FakeBridge } from './fake-bridge.ts'

const SPEC = {
  id: 'compile-clean',
  objective: { path: 'compileErrors', direction: 'minimize' },
  assertions: [{ id: 'errors', path: 'compileErrors', predicate: 'lte', target: 0 }],
  budgets: { maxIterations: 8 },
  repair: { margin: 1, maxNoImprovement: 3 },
}

let root: string | undefined
let context: Context | undefined
const open: FakeBridge[] = []

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await Promise.all(open.splice(0).map(bridge => bridge.close()))
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot a cordis.yml carrying the provider and the tool over a fake bridge URL. */
async function boot(bridgeUrl: string): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-provider-openness-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-provider-openness'",
    '  config:',
    `    url: ${JSON.stringify(bridgeUrl)}`,
    "- name: '@deepseek-ai/dsh-tool-spec-loop'",
    '  config:',
    '    models:',
    '      - provider: mock',
    '        model: mock',
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-provider-openness', { default: OpennessSpecLoopAdapter }],
    ['@deepseek-ai/dsh-tool-spec-loop', ToolSpecLoop],
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

describe('provider-openness real Loader composition through cordis.yml', () => {
  it('registers the adapter, registers the tool, and completes a satisfying initial-candidate run', async () => {
    const bridge = await startFakeBridge()
    open.push(bridge)
    const ctx = await boot(bridge.baseUrl)
    expect(ctx.get('specLoopAdapter')).toBeInstanceOf(OpennessSpecLoopAdapter)
    expect(ctx.tools.schemas().some(entry => entry.name === 'spec_loop')).toBe(true)

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('provider-openness-loader'),
      name: 'spec_loop',
      arguments: { spec: SPEC, initialParams: { coolingTimeMs: 12000 } },
    })
    expect(result.isError).toBe(false)
    expect((result.value as { status: string }).status).toBe('satisfied')
    expect(bridge.requests.filter(request => request.path === '/validate')).toHaveLength(1)
    expect(bridge.requests.filter(request => request.path === '/run')).toHaveLength(1)
    expect(bridge.requests.find(request => request.path === '/run')?.body).toMatchObject({
      params: { coolingTimeMs: 12000 },
    })
  }, 30_000)

  it('fails loading when neither url nor spawn.command is configured', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-provider-openness-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-provider-openness'",
      '',
    ].join('\n'))
    const ctx = new Context()
    context = ctx
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-provider-openness', { default: OpennessSpecLoopAdapter }],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await expect(ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } }))
      .rejects.toThrow(/requires exactly one of url/)
  }, 30_000)
})
