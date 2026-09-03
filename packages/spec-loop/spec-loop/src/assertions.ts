/**
 * Assertion evaluation: dot-path lookup into structured results and the three
 * acceptance predicates. Pure functions of their inputs.
 * @module @deepseek-ai/dsh-spec-loop
 */

import type { Assertion, AssertionResult, SpecLoopJson, SpecLoopMetrics } from './types.ts'

/**
 * Look up a numeric value at a dot path inside a structured result. Each path
 * segment names one object key; arrays are not traversed.
 * @param value - the structured result to search.
 * @param path - dot-separated key path, e.g. `max_stress_MPa` or `a.b.c`.
 * @returns the finite number at the path, or undefined when any segment is
 *   missing or the final value is not a finite number.
 */
export function lookupNumber(value: SpecLoopJson, path: string): number | undefined {
  let current: SpecLoopJson = value
  for (const segment of path.split('.')) {
    if (segment.length === 0 || typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
    const next = current[segment]
    if (next === undefined) return undefined
    current = next
  }
  if (typeof current !== 'number' || !Number.isFinite(current)) return undefined
  return current
}

/**
 * Decide whether one actual value satisfies an assertion predicate.
 * @param actual - the looked-up numeric value.
 * @param assertion - the predicate and threshold to apply.
 * @returns true when the predicate holds.
 */
export function evaluateAssertion(actual: number, assertion: Assertion): boolean {
  switch (assertion.predicate) {
    case 'lte':
      return actual <= (assertion.target as number)
    case 'gte':
      return actual >= (assertion.target as number)
    case 'between': {
      const [min, max] = assertion.target as [number, number]
      return actual >= min && actual <= max
    }
  }
}

/**
 * Evaluate every assertion against one structured result.
 * @param result - the adapter's structured metrics.
 * @param assertions - the spec's acceptance predicates.
 * @returns one result per assertion; `passed` is false and `actual` is absent
 *   when the metric path is missing or non-numeric.
 */
export function evaluateAssertions(result: SpecLoopMetrics, assertions: readonly Assertion[]): AssertionResult[] {
  const results: AssertionResult[] = []
  for (const assertion of assertions) {
    const actual = lookupNumber(result, assertion.path)
    if (actual === undefined) {
      results.push({ id: assertion.id, passed: false })
    } else {
      results.push({ id: assertion.id, passed: evaluateAssertion(actual, assertion), actual })
    }
  }
  return results
}
