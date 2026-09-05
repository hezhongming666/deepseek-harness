/**
 * Deterministic verifier registry — the design's adjudication layer. The
 * service registers named validators, ships the built-in Structured Text and
 * IO-consistency validators, and runs the check that decides whether an
 * artifact may flow to the next project stage. Verifiers are pure functions
 * of their input: no model calls, no environment reads, reproducible reports.
 * @module @deepseek-ai/dsh-ia-verifier
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { verifyIoConsistency, IO_CONSISTENCY_KIND } from './io-consistency.ts'
import { verifyStLint, ST_LINT_KIND } from './st/lint.ts'
import { verifyStSyntax, ST_SYNTAX_KIND } from './st/syntax.ts'
import { DuplicateVerifierError, UnknownVerifierError } from './types.ts'
import type { ValidatorDescriptor, VerificationInput, VerificationReport } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    iaVerifiers: IaVerifiers
  }
}

/** The built-in validators the registry can activate at load. */
const BUILTINS: ReadonlyArray<readonly [string, ValidatorDescriptor['verify']]> = [
  [ST_SYNTAX_KIND, input => Promise.resolve(verifyStSyntax(input))],
  [ST_LINT_KIND, input => Promise.resolve(verifyStLint(input))],
  [IO_CONSISTENCY_KIND, input => Promise.resolve(verifyIoConsistency(input))],
]

/**
 * Registry configuration.
 */
export interface Config {
  /**
   * Built-in validator kinds to activate at load (default all three).
   * An entry outside `st-syntax`, `st-lint`, `io-consistency` fails at load.
   */
  builtins?: string[]
}

/** Schemastery configuration for the verifier registry. */
export const Config: Schema<Config> = z.object({
  builtins: z.array(z.string()).default([...BUILTINS.map(([kind]) => kind)]),
})

/**
 * The named deterministic-validator registry. Extension providers register
 * additional kinds (e.g. a vendor compile adapter); gate and orchestrator
 * consumers read reports through {@link IaVerifiers.verify}.
 */
export class IaVerifiers extends Service {
  static Config: Schema<Config> = Config

  private readonly validators = new Map<string, ValidatorDescriptor>()

  /**
   * Create the registry and register the configured built-in validators.
   * @param ctx - Cordis context that owns the service.
   * @param config - which built-in validators to activate.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'iaVerifiers')
    const builtins = config.builtins ?? [...BUILTINS.map(([kind]) => kind)]
    for (const kind of builtins) {
      const builtin = BUILTINS.find(([name]) => name === kind)
      if (builtin === undefined) {
        throw new Error(`iaVerifiers: unknown builtin verifier ${JSON.stringify(kind)}; available: ${BUILTINS.map(([name]) => name).join(', ')}`)
      }
      const [name, verify] = builtin
      this.register({ kind: name, title: builtinTitle(name), description: builtinDescription(name), verify })
    }
  }

  /**
   * Register one named validator. Registration is an effect: the returned
   * disposer removes the kind again.
   * @param descriptor - the validator to register.
   * @returns a disposer removing the registration.
   */
  register(descriptor: ValidatorDescriptor): () => void {
    if (this.validators.has(descriptor.kind)) {
      throw new DuplicateVerifierError(descriptor.kind)
    }
    this.validators.set(descriptor.kind, descriptor)
    return () => {
      this.validators.delete(descriptor.kind)
    }
  }

  /**
   * List the registered validator kinds.
   * @returns the registered validator kinds, in registration order.
   */
  kinds(): string[] {
    return [...this.validators.keys()]
  }

  /**
   * Read one registered validator descriptor.
   * @param kind - the validator kind.
   * @returns the descriptor, or `undefined` when the kind is unregistered.
   */
  get(kind: string): ValidatorDescriptor | undefined {
    return this.validators.get(kind)
  }

  /**
   * Run one deterministic verification.
   * @param kind - the registered validator kind.
   * @param input - the checked text or JSON payload.
   * @returns the verification report, awaited when the validator round-trips
   *   an external tool.
   * @throws {@link UnknownVerifierError} when the kind is unregistered — the
   *   design's fail-loud rule: verification never silently skips.
   */
  async verify(kind: string, input: VerificationInput): Promise<VerificationReport> {
    const validator = this.validators.get(kind)
    if (validator === undefined) {
      throw new UnknownVerifierError(kind, this.kinds())
    }
    return validator.verify(input)
  }

  /**
   * Run several verifications over one input in the given order.
   * @param kinds - the validator kinds to run.
   * @param input - the checked text or JSON payload.
   * @returns one report per kind, in the requested order.
   * @throws {@link UnknownVerifierError} on the first unregistered kind.
   */
  async verifyAll(kinds: readonly string[], input: VerificationInput): Promise<VerificationReport[]> {
    return Promise.all(kinds.map(kind => this.verify(kind, input)))
  }
}

/** Human title of one built-in validator kind. */
function builtinTitle(kind: string): string {
  switch (kind) {
    case ST_SYNTAX_KIND: return 'Structured Text syntax check'
    case ST_LINT_KIND: return 'Structured Text lint check'
    case IO_CONSISTENCY_KIND: return 'IO-symbol consistency check'
    default: return kind
  }
}

/** Human description of one built-in validator kind. */
function builtinDescription(kind: string): string {
  switch (kind) {
    case ST_SYNTAX_KIND:
      return 'Deterministic lexical and syntactic check of the supported IEC 61131-3 Structured Text subset; input is ST source text.'
    case ST_LINT_KIND:
      return 'Name resolution and hygiene over parsed ST: undefined references, duplicate declarations, unknown types, loop control placement, unused variables; input is ST source text.'
    case IO_CONSISTENCY_KIND:
      return 'Two-way consistency between an IO point list and a symbol table; input is the JSON document described in the package README.'
    default:
      return kind
  }
}

export default IaVerifiers
export * from './types.ts'
export { verifyStSyntax, ST_SYNTAX_KIND } from './st/syntax.ts'
export { verifyStLint, ST_LINT_KIND } from './st/lint.ts'
export { verifyIoConsistency, IO_CONSISTENCY_KIND } from './io-consistency.ts'
