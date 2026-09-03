/**
 * Spec-loop run-id brand: one opaque id per loop run, owned by this package.
 * @module @deepseek-ai/dsh-spec-loop/brand
 */

import type { SpecLoopRunId } from './types.ts'

/**
 * Brand a plain string as a spec-loop run id.
 * @param value - the id string, non-empty and caller-unique.
 * @returns the branded id.
 */
export function SpecLoopRunId(value: string): SpecLoopRunId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('SpecLoopRunId must be a non-empty string')
  }
  return value as SpecLoopRunId
}
