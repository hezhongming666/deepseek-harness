import { describe, expect, it } from 'vitest'
import { SpecLoopError, validateSpec } from '../src/index.ts'

const VALID = {
  id: 'demo-spec',
  objective: { path: 'stress_MPa', direction: 'minimize' },
  assertions: [{ id: 'cap', path: 'stress_MPa', predicate: 'lte', target: 400 }],
  budgets: { maxIterations: 10, maxWallClockMs: 60_000, maxTokens: 100_000 },
  repair: { margin: 1, maxNoImprovement: 3, maxConsecutiveInfrastructure: 2 },
  envelope: { bounds: { thickness: { min: 0, max: 10 } } },
  description: 'Minimize peak stress by choosing the shell thickness.',
}

describe('validateSpec', () => {
  it('accepts a complete spec and returns a frozen normalized view', () => {
    const spec = validateSpec(VALID)
    expect(spec.id).toBe('demo-spec')
    expect(spec.objective).toEqual({ path: 'stress_MPa', direction: 'minimize' })
    expect(spec.assertions).toEqual([{ id: 'cap', path: 'stress_MPa', predicate: 'lte', target: 400 }])
    expect(spec.budgets).toEqual({ maxIterations: 10, maxWallClockMs: 60_000, maxTokens: 100_000 })
    expect(spec.repair).toEqual({ margin: 1, maxNoImprovement: 3, maxConsecutiveInfrastructure: 2 })
    expect(spec.envelope).toEqual({ bounds: { thickness: { min: 0, max: 10 } } })
    expect(spec.description).toBe(VALID.description)
    expect(Object.isFrozen(spec)).toBe(true)
  })

  it('accepts a minimal spec with only required fields', () => {
    const spec = validateSpec({
      id: 'minimal',
      objective: { path: 'cost', direction: 'minimize' },
      assertions: [{ id: 'a', path: 'cost', predicate: 'gte', target: 0 }],
      budgets: { maxIterations: 1 },
      repair: { margin: 0, maxNoImprovement: 1 },
    })
    expect(spec.budgets.maxWallClockMs).toBeUndefined()
    expect(spec.budgets.maxTokens).toBeUndefined()
    expect(spec.repair.maxConsecutiveInfrastructure).toBeUndefined()
    expect(spec.envelope).toBeUndefined()
    expect(spec.description).toBeUndefined()
  })

  it.each([
    { label: 'not an object', raw: null, message: 'invalid spec: must be a JSON object' },
    { label: 'blank id', raw: { ...VALID, id: '  ' }, message: 'invalid spec: id must be a non-empty string' },
    { label: 'missing objective', raw: { ...VALID, objective: undefined }, message: 'invalid spec: objective must be an object' },
    { label: 'blank objective path', raw: { ...VALID, objective: { path: '', direction: 'minimize' } }, message: 'invalid spec: objective.path must be a non-empty string' },
    { label: 'unknown direction', raw: { ...VALID, objective: { path: 'p', direction: 'sideways' } }, message: 'invalid spec: objective.direction must be minimize or maximize (got "sideways")' },
    { label: 'empty assertions', raw: { ...VALID, assertions: [] }, message: 'invalid spec: assertions must be a non-empty array' },
    { label: 'blank assertion id', raw: { ...VALID, assertions: [{ id: '', path: 'p', predicate: 'lte', target: 1 }] }, message: 'spec assertion at assertions[0]: id must be a non-empty string' },
    { label: 'unknown predicate', raw: { ...VALID, assertions: [{ id: 'a', path: 'p', predicate: 'approx', target: 1 }] }, message: 'spec assertion at assertions[0]: predicate must be lte, gte, or between (got "approx")' },
    { label: 'non-numeric target', raw: { ...VALID, assertions: [{ id: 'a', path: 'p', predicate: 'lte', target: '1' }] }, message: 'spec assertion at assertions[0]: target must be a finite number' },
    { label: 'between target not a pair', raw: { ...VALID, assertions: [{ id: 'a', path: 'p', predicate: 'between', target: [1] }] }, message: 'spec assertion at assertions[0]: between target must be a [min, max] pair' },
    { label: 'between target reversed', raw: { ...VALID, assertions: [{ id: 'a', path: 'p', predicate: 'between', target: [5, 1] }] }, message: 'spec assertion at assertions[0]: between target min must not exceed max' },
    { label: 'missing budgets', raw: { ...VALID, budgets: undefined }, message: 'invalid spec: budgets must be an object' },
    { label: 'zero maxIterations', raw: { ...VALID, budgets: { maxIterations: 0 } }, message: 'invalid spec: budgets.maxIterations must be a positive safe integer' },
    { label: 'negative maxTokens', raw: { ...VALID, budgets: { maxIterations: 1, maxTokens: -1 } }, message: 'invalid spec: budgets.maxTokens must be a positive safe integer' },
    { label: 'fractional maxWallClockMs', raw: { ...VALID, budgets: { maxIterations: 1, maxWallClockMs: 1.5 } }, message: 'invalid spec: budgets.maxWallClockMs must be a positive safe integer' },
    { label: 'missing repair', raw: { ...VALID, repair: undefined }, message: 'invalid spec: repair must be an object' },
    { label: 'negative margin', raw: { ...VALID, repair: { margin: -1, maxNoImprovement: 3 } }, message: 'invalid spec: repair.margin must be a non-negative finite number' },
    { label: 'zero maxNoImprovement', raw: { ...VALID, repair: { margin: 1, maxNoImprovement: 0 } }, message: 'invalid spec: repair.maxNoImprovement must be a positive safe integer' },
    { label: 'fractional maxConsecutiveInfrastructure', raw: { ...VALID, repair: { margin: 1, maxNoImprovement: 3, maxConsecutiveInfrastructure: 1.5 } }, message: 'invalid spec: repair.maxConsecutiveInfrastructure must be a positive safe integer' },
    { label: 'envelope without bounds', raw: { ...VALID, envelope: {} }, message: 'invalid spec: envelope.bounds must be an object' },
    { label: 'blank bound path', raw: { ...VALID, envelope: { bounds: { '  ': { min: 0, max: 1 } } } }, message: 'invalid spec: envelope.bounds path must be non-empty' },
    { label: 'bound without min', raw: { ...VALID, envelope: { bounds: { p: { max: 1 } } } }, message: 'spec envelope bound at envelope.bounds.p: min and max must be finite numbers' },
    { label: 'reversed bounds', raw: { ...VALID, envelope: { bounds: { p: { min: 5, max: 1 } } } }, message: 'spec envelope bound at envelope.bounds.p: min must not exceed max' },
    { label: 'blank description', raw: { ...VALID, description: ' ' }, message: 'invalid spec: description must be a non-empty string when present' },
  ])('rejects $label with INVALID_SPEC', ({ raw, message }) => {
    try {
      validateSpec(raw)
      expect.unreachable('validateSpec must reject')
    } catch (error) {
      expect(error).toBeInstanceOf(SpecLoopError)
      expect((error as SpecLoopError).message).toBe(message)
      expect((error as SpecLoopError).code).toBe('INVALID_SPEC')
    }
  })
})
