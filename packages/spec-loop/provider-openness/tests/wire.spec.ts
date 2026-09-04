import { describe, expect, it } from 'vitest'
import { parseHealthResponse, parseRunResponse, parseValidateResponse } from '../src/wire.ts'

describe('wire validators', () => {
  it('accepts a complete successful run response', () => {
    const outcome = parseRunResponse({
      runId: 'r1',
      status: 'success',
      result: { compileErrors: 0, compileMs: 100 },
      licenseMs: 100,
      environment: { softwareVersion: 'TIA Portal Openness 21.0.0.0', osKernel: 'win' },
    })
    expect(outcome).toMatchObject({
      runId: 'r1',
      status: 'success',
      result: { compileErrors: 0, compileMs: 100 },
      licenseMs: 100,
      environment: { softwareVersion: 'TIA Portal Openness 21.0.0.0', osKernel: 'win' },
    })
  })

  it('accepts a diverged run response with a diagnosis and no result', () => {
    expect(parseRunResponse({ runId: 'r2', status: 'diverged', error: 'compile faulted' }))
      .toEqual({ runId: 'r2', status: 'diverged', error: 'compile faulted' })
  })

  it('treats null optional fields as absent', () => {
    expect(parseRunResponse({ runId: 'r3', status: 'success', result: {}, error: null, environment: null }))
      .toEqual({ runId: 'r3', status: 'success', result: {} })
    expect(parseHealthResponse({ ok: true, environment: null, error: null })).toEqual({ ok: true })
  })

  it.each([
    ['non-object', 42],
    ['missing runId', { status: 'success', result: {} }],
    ['empty runId', { runId: '', status: 'success', result: {} }],
    ['unknown status', { runId: 'r', status: 'exploded', result: {}, error: 'x' }],
    ['success without result', { runId: 'r', status: 'success' }],
    ['diverged with result', { runId: 'r', status: 'diverged', error: 'x', result: {} }],
    ['non-finite licenseMs', { runId: 'r', status: 'success', result: {}, licenseMs: Number.NaN }],
    ['diverged without error', { runId: 'r', status: 'diverged' }],
    ['empty error', { runId: 'r', status: 'diverged', error: '  ' }],
  ])('rejects a malformed run response: %s', (_label, value) => {
    expect(() => parseRunResponse(value)).toThrow(TypeError)
  })

  it('accepts ok and refused validate responses', () => {
    expect(parseValidateResponse({ ok: true, reasons: [] })).toEqual({ ok: true, reasons: [] })
    expect(parseValidateResponse({ ok: false, reasons: ['unknown parameter "x"'] }))
      .toEqual({ ok: false, reasons: ['unknown parameter "x"'] })
  })

  it.each([
    ['non-object', 42],
    ['non-boolean ok', { ok: 'yes', reasons: [] }],
    ['refusal without reasons', { ok: false, reasons: [] }],
    ['empty reason', { ok: false, reasons: [''] }],
    ['non-string reason', { ok: false, reasons: [3] }],
  ])('rejects a malformed validate response: %s', (_label, value) => {
    expect(() => parseValidateResponse(value)).toThrow(TypeError)
  })

  it('accepts ready and unready health responses', () => {
    expect(parseHealthResponse({ ok: true, environment: { softwareVersion: 'v1' } }))
      .toEqual({ ok: true, environment: { softwareVersion: 'v1' } })
    expect(parseHealthResponse({ ok: false, error: 'TIA Portal not reachable' }))
      .toEqual({ ok: false, error: 'TIA Portal not reachable' })
  })

  it('rejects a malformed health response', () => {
    expect(() => parseHealthResponse({ ok: false })).toThrow(TypeError)
    expect(() => parseHealthResponse({ ok: 'yes' })).toThrow(TypeError)
  })
})
