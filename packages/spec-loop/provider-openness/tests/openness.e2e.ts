// Real-API e2e: a live DeepSeek model proposes candidates through the
// spec_loop generation chain while the Openness adapter executes them against
// the fake bridge. Key-gated — skips entirely without $DEEPSEEK_API_KEY (see
// vitest.e2e.config.ts). The assertion verifies the bridge's external state
// (received validate/run calls with numeric parameters), never the model's
// claim.
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
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
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
  budgets: { maxIterations: 6, maxWallClockMs: 300_000 },
  repair: { margin: 1, maxNoImprovement: 3 },
  envelope: { bounds: { coolingTimeMs: { min: 0, max: 60000 }, threshold: { min: 0, max: 100 } } },
  description: 'coolingTimeMs and threshold are global-DB member start values set before the compile.',
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

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('provider-openness e2e (real API)', () => {
  it('drives a live-model spec_loop through the Openness adapter', async () => {
    const bridge = await startFakeBridge()
    open.push(bridge)
    root = await mkdtemp(join(tmpdir(), 'dsh-openness-e2e-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-llm-deepseek'",
      '  config:',
      '    models:',
      '      - id: deepseek-v4-flash',
      "- name: '@deepseek-ai/dsh-provider-openness'",
      '  config:',
      `    url: ${JSON.stringify(bridge.baseUrl)}`,
      "- name: '@deepseek-ai/dsh-tool-spec-loop'",
      '  config:',
      '    models:',
      '      - provider: deepseek-official',
      '        model: deepseek-v4-flash',
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
      ['@deepseek-ai/dsh-llm-deepseek', LlmDeepSeek],
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

    const result = await ctx.tools.execute({
      signal: AbortSignal.timeout(120_000),
      callId: CallId('provider-openness-e2e'),
      name: 'spec_loop',
      arguments: { spec: SPEC },
    })
    expect(result.isError).toBe(false)
    const value = result.value as { status: string; iterations: Array<{ verdict: string; params?: unknown }> }
    expect(value.status).toBe('satisfied')
    expect(value.iterations.length).toBeGreaterThan(0)
    const validates = bridge.requests.filter(request => request.path === '/validate')
    const runs = bridge.requests.filter(request => request.path === '/run')
    expect(validates.length).toBe(value.iterations.length)
    expect(runs.length).toBe(value.iterations.length)
    for (const run of runs) {
      const params = (run.body as { params?: { coolingTimeMs?: number; threshold?: number } }).params
      expect(typeof params?.coolingTimeMs).toBe('number')
      expect(typeof params?.threshold).toBe('number')
    }
  }, 180_000)
})
