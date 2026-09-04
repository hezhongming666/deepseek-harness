// One-off real-bridge spec_loop smoke: boots the Loader composition with
// provider-openness pointing at the live TIA bridge and drives spec_loop
// with an initial candidate (no model generation, no API key).
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolSpecLoop from '@deepseek-ai/dsh-tool-spec-loop'
import OpennessSpecLoopAdapter from '@deepseek-ai/dsh-provider-openness'

const BRIDGE_URL = 'http://127.0.0.1:4281'

const SPEC = {
  id: 'compile-clean-real-tia',
  objective: { path: 'compileErrors', direction: 'minimize' },
  assertions: [{ id: 'errors', path: 'compileErrors', predicate: 'lte', target: 0 }],
  budgets: { maxIterations: 8 },
  repair: { margin: 1, maxNoImprovement: 3 },
}

const root = await mkdtemp(join(tmpdir(), 'dsh-spec-loop-real-'))
const configPath = join(root, 'cordis.yml')
await writeFile(configPath, [
  "- name: '@deepseek-ai/dsh-system-prompt'",
  "- name: '@deepseek-ai/dsh-tools'",
  "- name: '@deepseek-ai/dsh-llm'",
  "- name: '@deepseek-ai/dsh-provider-openness'",
  '  config:',
  `    url: ${JSON.stringify(BRIDGE_URL)}`,
  "- name: '@deepseek-ai/dsh-tool-spec-loop'",
  '  config:',
  '    models:',
  '      - provider: mock',
  '        model: mock',
  '',
].join('\n'))

const ctx = new Context()
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

const result = await ctx.tools.execute({
  signal: AbortSignal.timeout(300_000),
  callId: CallId('spec-loop-real-bridge-smoke'),
  name: 'spec_loop',
  arguments: { spec: SPEC, initialParams: {} },
})
console.log('isError:', result.isError)
console.log(JSON.stringify(result.value, null, 2))
console.log(result.content?.[0] && typeof result.content[0] === 'object' && 'text' in result.content[0]
  ? (result.content[0] as { text: string }).text
  : '')

await ctx.fiber.dispose()
await rm(root, { recursive: true, force: true })
