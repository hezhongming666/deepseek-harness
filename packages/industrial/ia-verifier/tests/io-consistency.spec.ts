// Behavior of the `io-consistency` validator over its JSON document.
import { describe, expect, it } from 'vitest'
import { verifyIoConsistency } from '@deepseek-ai/dsh-ia-verifier'

const CONSISTENT = JSON.stringify({
  io: [
    { tag: 'CYL_A_EXT', address: '%Q0.0' },
    { tag: 'START_PB', address: '%I0.0' },
  ],
  symbols: [
    { name: 'CYL_A_EXT' },
    { name: 'START_PB' },
  ],
})

describe('io-consistency validator', () => {
  it('passes a document where every tag and symbol pair up', () => {
    const report = verifyIoConsistency({ text: CONSISTENT })
    expect(report.kind).toBe('io-consistency')
    expect(report.pass).toBe(true)
    expect(report.diagnostics).toEqual([])
    expect(report.evidence[0]).toEqual(expect.objectContaining({ kind: 'io-map' }))
  })

  it('fails on malformed JSON', () => {
    const report = verifyIoConsistency({ text: '{ not json' })
    expect(report.pass).toBe(false)
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: 'io-consistency-invalid-json' }))
  })

  it('fails when the document lacks the io/symbols arrays', () => {
    expect(verifyIoConsistency({ text: '{}' }).pass).toBe(false)
    expect(verifyIoConsistency({ text: '{"io": []}' }).pass).toBe(false)
  })

  it('reports a duplicate io tag', () => {
    const text = JSON.stringify({
      io: [{ tag: 'A', address: '%Q0.0' }, { tag: 'A', address: '%Q0.1' }],
      symbols: [{ name: 'A' }],
    })
    expect(verifyIoConsistency({ text }).diagnostics)
      .toContainEqual(expect.objectContaining({ code: 'io-consistency-duplicate-tag' }))
  })

  it('reports one address assigned to several io entries', () => {
    const text = JSON.stringify({
      io: [{ tag: 'A', address: '%Q0.0' }, { tag: 'B', address: '%Q0.0' }],
      symbols: [{ name: 'A' }, { name: 'B' }],
    })
    expect(verifyIoConsistency({ text }).diagnostics)
      .toContainEqual(expect.objectContaining({ code: 'io-consistency-duplicate-address' }))
  })

  it('reports duplicate symbols', () => {
    const text = JSON.stringify({
      io: [{ tag: 'A', address: '%Q0.0' }],
      symbols: [{ name: 'A' }, { name: 'A' }],
    })
    expect(verifyIoConsistency({ text }).diagnostics)
      .toContainEqual(expect.objectContaining({ code: 'io-consistency-duplicate-symbol' }))
  })

  it('fails an io point whose tag has no matching symbol', () => {
    const text = JSON.stringify({
      io: [{ tag: 'A', address: '%Q0.0' }, { tag: 'ORPHAN', address: '%Q0.1' }],
      symbols: [{ name: 'A' }],
    })
    const report = verifyIoConsistency({ text })
    expect(report.pass).toBe(false)
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: 'io-consistency-missing-symbol',
      severity: 'error',
    }))
  })

  it('warns about a symbol with no io point and keeps the verdict passing', () => {
    const text = JSON.stringify({
      io: [{ tag: 'A', address: '%Q0.0' }],
      symbols: [{ name: 'A' }, { name: 'LOCAL_FLAG' }],
    })
    const report = verifyIoConsistency({ text })
    expect(report.pass).toBe(true)
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: 'io-consistency-orphan-symbol',
      severity: 'warning',
    }))
  })

  it('rejects entries with malformed tag or address fields', () => {
    const text = JSON.stringify({
      io: [{ tag: '', address: '%Q0.0' }, { tag: 'B', address: '' }],
      symbols: [{ name: 'B' }],
    })
    const report = verifyIoConsistency({ text })
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: 'io-consistency-malformed-tag' }))
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: 'io-consistency-malformed-address' }))
  })

  it('rejects symbol entries with malformed names', () => {
    const text = JSON.stringify({
      io: [{ tag: 'A', address: '%Q0.0' }],
      symbols: [{ name: '' }],
    })
    expect(verifyIoConsistency({ text }).diagnostics)
      .toContainEqual(expect.objectContaining({ code: 'io-consistency-malformed-name' }))
  })
})
