// Proves the tool composes through a real cordis.yml Loader boot: the models
// chain is required config (misconfiguration fails at load), the tool registers
// with its schema, and a satisfying initial-candidate run completes without any
// LLM call, resolving the adapter through the composed service store.
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
import { SpecLoopAdapterService } from '@deepseek-ai/dsh-spec-loop'
import type { AdapterRunOutcome, AdapterRunRequest, ValidationOutcome } from '@deepseek-ai/dsh-spec-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolSpecLoop from '@deepseek-ai/dsh-tool-spec-loop'

/** Deterministic in-process adapter: thickness 6 passes, everything else fails. */
class FakeAdapterService extends SpecLoopAdapterService {
  async validate(): Promise<ValidationOutcome> {
    return { ok: true, reasons: [] }
  }

  async run(request: AdapterRunRequest): Promise<AdapterRunOutcome> {
    const thickness = request.params['thickness']
    return { status: 'success', result: { stress_MPa: thickness === 6 ? 300 : 500 } }
  }
}

const SPEC = {
  id: 'beam-demo',
  objective: { path: 'stress_MPa', direction: 'minimize' },
  assertions: [{ id: 'cap', path: 'stress_MPa', predicate: 'lte', target: 400 }],
  budgets: { maxIterations: 8 },
  repair: { margin: 1, maxNoImprovement: 3 },
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot a cordis.yml carrying the given tool-spec-loop config lines. */
async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-spec-loop-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/test-spec-loop-adapter'",
    "- name: '@deepseek-ai/dsh-tool-spec-loop'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
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
    ['@deepseek-ai/test-spec-loop-adapter', { default: FakeAdapterService }],
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

const CONFIG_MODELS = [
  '    models:',
  '      - provider: mock',
  '        model: mock',
]

describe('tool-spec-loop real Loader composition through cordis.yml', () => {
  it('registers the tool and completes a satisfying initial-candidate run', async () => {
    const ctx = await boot(CONFIG_MODELS)
    expect(ctx.tools.schemas().some(entry => entry.name === 'spec_loop')).toBe(true)

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('spec-loop-loader'),
      name: 'spec_loop',
      arguments: { spec: SPEC, initialParams: { thickness: 6 } },
    })
    expect(result.isError).toBe(false)
    expect((result.value as { status: string }).status).toBe('satisfied')
    expect(ctx.get('specLoopAdapter')).toBeInstanceOf(FakeAdapterService)
  }, 30_000)

  it.each([
    { label: 'is omitted', configLines: [], failure: '$.models missing required value' },
  ])('fails loading when the models chain $label', async ({ configLines, failure }) => {
    // The fallback chain is deployment policy, so its absence fails at load:
    // the entry's apply rejects and boot never reaches a running tool.
    await expect(boot(configLines)).rejects.toThrow(failure)
  }, 30_000)
})
