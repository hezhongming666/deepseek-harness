/**
 * Snapshot persistence for the knowledge service: every entry with its
 * citation, review status, and the issuing ordinal, as one versioned JSON
 * snapshot under the configured `dataDir`.
 * @module @deepseek-ai/dsh-ia-knowledge/persistence
 */

import { join } from 'node:path'
import { readJsonSnapshot, writeJsonSnapshot } from '@deepseek-ai/dsh-atomic-write'
import { LIBRARY_KINDS, KnowledgeEntryId } from './types.ts'
import type { KnowledgeEntry, LibraryKind } from './types.ts'

/** The snapshot file name under `dataDir`. */
export const KNOWLEDGE_SNAPSHOT_NAME = 'ia-knowledge.json'
/** The snapshot format version; bump only with a coordinated reader change. */
export const KNOWLEDGE_SNAPSHOT_VERSION = 1

/** The persisted knowledge-service state. */
export interface KnowledgeSnapshotState {
  /** The highest issued entry ordinal. */
  ordinal: number
  /** Every entry across libraries, in recording order. */
  entries: KnowledgeEntry[]
}

/** The snapshot path for one data directory.
 * @param dataDir - the configured data directory.
 * @returns the snapshot file path.
 */
export function knowledgeSnapshotPath(dataDir: string): string {
  return join(dataDir, KNOWLEDGE_SNAPSHOT_NAME)
}

/** Guard for plain JSON records (snapshot bodies arrive via `JSON.parse`). */
function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read one required non-empty string field. */
function requiredText(record: { [key: string]: unknown }, field: string, subject: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${subject} field ${JSON.stringify(field)} must be a non-empty string`)
  }
  return value
}

/** Read one non-negative finite number field. */
function nonNegativeNumber(record: { [key: string]: unknown }, field: string, subject: string): number {
  const value = record[field]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${subject} field ${JSON.stringify(field)} must be a non-negative number`)
  }
  return value
}

/** Validate one restored knowledge entry. */
function validateEntry(value: unknown, subject: string): KnowledgeEntry {
  if (!isRecord(value)) throw new Error(`${subject} entry must be an object`)
  const library = value['library']
  if (typeof library !== 'string' || !LIBRARY_KINDS.includes(library as LibraryKind)) {
    throw new Error(`${subject} entry library must be one of ${LIBRARY_KINDS.join(', ')}`)
  }
  const reviewStatus = value['reviewStatus']
  if (reviewStatus !== 'pending-review' && reviewStatus !== 'approved') {
    throw new Error(`${subject} entry reviewStatus must be "pending-review" or "approved"`)
  }
  const tags = value['tags']
  if (!Array.isArray(tags) || tags.some((tag: unknown) => typeof tag !== 'string')) {
    throw new Error(`${subject} entry tags must be an array of strings`)
  }
  return {
    id: KnowledgeEntryId(requiredText(value, 'id', subject)),
    library: library as LibraryKind,
    title: requiredText(value, 'title', subject),
    content: requiredText(value, 'content', subject),
    tags: tags as string[],
    source: requiredText(value, 'source', subject),
    version: requiredText(value, 'version', subject),
    reviewStatus,
    recordedBy: requiredText(value, 'recordedBy', subject),
    recordedAt: nonNegativeNumber(value, 'recordedAt', subject),
  }
}

/**
 * Load the knowledge snapshot: `undefined` for a fresh store, or the
 * validated state. Corrupt, wrong-version, or malformed snapshots throw and
 * name the file — a store never silently degrades.
 * @param dataDir - the configured data directory.
 * @returns the restored state, or `undefined` when no snapshot exists.
 */
export function loadKnowledgeSnapshot(dataDir: string): KnowledgeSnapshotState | undefined {
  const file = knowledgeSnapshotPath(dataDir)
  const raw = readJsonSnapshot(file, KNOWLEDGE_SNAPSHOT_VERSION)
  if (raw === undefined) return undefined
  const subject = `iaKnowledge snapshot ${file}`
  if (!isRecord(raw)) throw new Error(`${subject} state must be an object`)
  const ordinal = nonNegativeNumber(raw, 'ordinal', subject)
  const entriesValue = raw['entries']
  if (!Array.isArray(entriesValue)) throw new Error(`${subject} field "entries" must be an array`)
  const entries = entriesValue.map((value, index) => validateEntry(value, `${subject} entry #${index}`))
  return { ordinal, entries }
}

/**
 * Persist the knowledge state as one atomic snapshot.
 * @param dataDir - the configured data directory.
 * @param state - the complete current state.
 */
export function saveKnowledgeSnapshot(dataDir: string, state: KnowledgeSnapshotState): void {
  writeJsonSnapshot(knowledgeSnapshotPath(dataDir), KNOWLEDGE_SNAPSHOT_VERSION, state)
}
