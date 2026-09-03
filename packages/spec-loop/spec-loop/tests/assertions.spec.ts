import { describe, expect, it } from 'vitest'
import type { Assertion } from '../src/index.ts'
import { evaluateAssertion, evaluateAssertions, lookupNumber } from '../src/index.ts'

describe('lookupNumber', () => {
  it('reads nested numeric values at a dot path', () => {
    expect(lookupNumber({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42)
    expect(lookupNumber({ max_stress_MPa: 812 }, 'max_stress_MPa')).toBe(812)
  })

  it('returns undefined for missing, non-object, or non-numeric values', () => {
    expect(lookupNumber({ a: { b: 1 } }, 'a.c')).toBeUndefined()
    expect(lookupNumber({ a: 1 }, 'a.b')).toBeUndefined()
    expect(lookupNumber({ a: '1' }, 'a')).toBeUndefined()
    expect(lookupNumber({ a: null }, 'a')).toBeUndefined()
    expect(lookupNumber({ a: Infinity }, 'a')).toBeUndefined()
    expect(lookupNumber([1, 2], '0')).toBeUndefined()
    expect(lookupNumber({ a: { b: 1 } }, 'a..b')).toBeUndefined()
    expect(lookupNumber({ a: { b: 1 } }, 'a.')).toBeUndefined()
  })
})

describe('evaluateAssertion', () => {
  it('applies lte and gte inclusive thresholds', () => {
    expect(evaluateAssertion(400, { id: 'x', path: 'p', predicate: 'lte', target: 400 })).toBe(true)
    expect(evaluateAssertion(401, { id: 'x', path: 'p', predicate: 'lte', target: 400 })).toBe(false)
    expect(evaluateAssertion(400, { id: 'x', path: 'p', predicate: 'gte', target: 400 })).toBe(true)
    expect(evaluateAssertion(399, { id: 'x', path: 'p', predicate: 'gte', target: 400 })).toBe(false)
  })

  it('applies inclusive between ranges', () => {
    const assertion: Assertion = { id: 'x', path: 'p', predicate: 'between', target: [10, 20] }
    expect(evaluateAssertion(10, assertion)).toBe(true)
    expect(evaluateAssertion(20, assertion)).toBe(true)
    expect(evaluateAssertion(9.9, assertion)).toBe(false)
    expect(evaluateAssertion(20.1, assertion)).toBe(false)
  })
})

describe('evaluateAssertions', () => {
  it('returns one passed/failed result per assertion', () => {
    const results = evaluateAssertions(
      { stress: 500, mass: 12 },
      [
        { id: 'stress-cap', path: 'stress', predicate: 'lte', target: 400 },
        { id: 'mass-range', path: 'mass', predicate: 'between', target: [10, 15] },
        { id: 'missing', path: 'nope', predicate: 'gte', target: 1 },
      ],
    )
    expect(results).toEqual([
      { id: 'stress-cap', passed: false, actual: 500 },
      { id: 'mass-range', passed: true, actual: 12 },
      { id: 'missing', passed: false },
    ])
  })
})
