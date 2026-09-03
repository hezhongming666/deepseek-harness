/**
 * Spec-loop capability: the deterministic loop engine, the spec contract
 * validator, and the software adapter seam.
 * @module @deepseek-ai/dsh-spec-loop
 */

export { SpecLoopRunId } from './brand.ts'
export * from './types.ts'
export { lookupNumber, evaluateAssertion, evaluateAssertions } from './assertions.ts'
export { SpecLoopError, validateSpec } from './spec.ts'
export type { SpecLoopErrorCode } from './spec.ts'
export { runSpecLoop } from './engine.ts'
export type { SpecLoopCeilings, SpecLoopRunRequest } from './engine.ts'
export { SpecLoopAdapterService } from './adapter.ts'
export { default } from './adapter.ts'
