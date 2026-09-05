// Registry behavior: builtin activation, registration effects, fail-loud paths.
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import IaVerifiers, { DuplicateVerifierError, UnknownVerifierError } from '@deepseek-ai/dsh-ia-verifier'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

async function makeRegistry(builtins?: string[]): Promise<IaVerifiers> {
  context = new Context()
  await context.plugin(IaVerifiers, builtins === undefined ? {} : { builtins })
  return context.iaVerifiers
}

describe('IaVerifiers registry', () => {
  it('registers the three built-in validators by default', async () => {
    const registry = await makeRegistry()
    expect(registry.kinds()).toEqual(['st-syntax', 'st-lint', 'io-consistency'])
  })

  it('fails at load on an unknown builtin kind', async () => {
    await expect(makeRegistry(['st-syntax', 'nope'])).rejects.toThrow(/unknown builtin verifier "nope"/)
  })

  it('verify fails loud on an unregistered kind, naming the registered ones', async () => {
    const registry = await makeRegistry(['st-syntax'])
    await expect(registry.verify('io-consistency', { text: '' })).rejects.toThrow(UnknownVerifierError)
    try {
      await registry.verify('io-consistency', { text: '' })
    } catch (error) {
      expect((error as UnknownVerifierError).code).toBe('IA_VERIFIER_UNKNOWN_KIND')
      expect((error as UnknownVerifierError).message).toContain('st-syntax')
    }
  })

  it('rejects duplicate kind registration', async () => {
    const registry = await makeRegistry(['st-syntax'])
    const builtin = registry.get('st-syntax')
    if (builtin === undefined) throw new Error('builtin st-syntax missing')
    const extra = {
      kind: 'st-syntax',
      title: 'dup',
      description: 'duplicate registration',
      verify: async (input: { text: string }) => builtin.verify(input),
    }
    expect(() => registry.register(extra)).toThrow(DuplicateVerifierError)
  })

  it('registration is an effect: the disposer removes the kind again', async () => {
    const registry = await makeRegistry([])
    const descriptor = {
      kind: 'probe',
      title: 'probe',
      description: 'a test validator',
      verify: async (_input: { text: string }) => ({
        kind: 'probe',
        pass: true,
        diagnostics: [],
        evidence: [{ kind: 'probe', summary: 'probe ran' }],
      }),
    }
    const dispose = registry.register(descriptor)
    expect(registry.kinds()).toContain('probe')
    dispose()
    expect(registry.kinds()).not.toContain('probe')
  })

  it('verifyAll runs every requested kind in order and throws on the first unknown one', async () => {
    const registry = await makeRegistry()
    const reports = await registry.verifyAll(['st-syntax', 'st-lint'], { text: 'PROGRAM p END_PROGRAM' })
    expect(reports.map(report => report.kind)).toEqual(['st-syntax', 'st-lint'])
    await expect(registry.verifyAll(['st-syntax', 'missing'], { text: '' })).rejects.toThrow(UnknownVerifierError)
  })
})
