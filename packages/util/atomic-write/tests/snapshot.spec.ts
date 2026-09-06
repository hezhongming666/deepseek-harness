/**
 * Snapshot helpers: versioned JSON round-trips, fresh-store absence, and the
 * fail-loud paths (unreadable, malformed, wrong-version, non-record).
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readJsonSnapshot, writeJsonSnapshot } from '@deepseek-ai/dsh-atomic-write'

let dir: string | undefined

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function snapshot(): string {
  dir = mkdtempSync(join(tmpdir(), 'dsh-atomic-write-snapshot-'))
  return join(dir, 'store.json')
}

describe('json snapshot helpers', () => {
  it('round-trips one versioned state and replaces it atomically', () => {
    const file = snapshot()
    expect(readJsonSnapshot(file, 1)).toBeUndefined()
    writeJsonSnapshot(file, 1, { entries: ['a'] })
    expect(readJsonSnapshot(file, 1)).toEqual({ entries: ['a'] })
    writeJsonSnapshot(file, 1, { entries: ['a', 'b'] })
    expect(readJsonSnapshot(file, 1)).toEqual({ entries: ['a', 'b'] })
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { version: number }
    expect(raw.version).toBe(1)
    expect(readdirSync(dir!).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('creates missing parent directories', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-atomic-write-snapshot-'))
    const file = join(dir, 'nested', 'deep', 'store.json')
    writeJsonSnapshot(file, 2, 'state')
    expect(readJsonSnapshot(file, 2)).toBe('state')
  })

  it('fails loud on a format version mismatch, naming the expectation', () => {
    const file = snapshot()
    writeJsonSnapshot(file, 1, {})
    expect(() => readJsonSnapshot(file, 2)).toThrow(/format version 1, expected 2/)
  })

  it('fails loud on malformed JSON and on non-record content', () => {
    const file = snapshot()
    writeFileSync(file, '{not json')
    expect(() => readJsonSnapshot(file, 1)).toThrow(/malformed JSON/)
    writeFileSync(file, JSON.stringify([1, 2]))
    expect(() => readJsonSnapshot(file, 1)).toThrow(/versioned record object/)
  })
})
