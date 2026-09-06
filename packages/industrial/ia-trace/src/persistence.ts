/**
 * Snapshot persistence for the traceability service: every scoped project's
 * nodes, links, change records, and issuing ordinal, as one versioned JSON
 * snapshot under the configured `dataDir`.
 * @module @deepseek-ai/dsh-ia-trace/persistence
 */

import { join } from 'node:path'
import { readJsonSnapshot, writeJsonSnapshot } from '@deepseek-ai/dsh-atomic-write'
import { TRACE_LINK_KINDS, TRACE_NODE_KINDS, TraceNodeId } from './types.ts'
import type { ChangeRecord, TraceLink, TraceLinkKind, TraceNode, TraceNodeKind } from './types.ts'

/** The snapshot file name under `dataDir`. */
export const TRACE_SNAPSHOT_NAME = 'ia-trace.json'
/** The snapshot format version; bump only with a coordinated reader change. */
export const TRACE_SNAPSHOT_VERSION = 1

/** One scoped project's persisted state. */
export interface TraceProjectState {
  /** The caller-chosen scope key, e.g. the agent's session id. */
  scope: string
  /** The highest issued node ordinal. */
  ordinal: number
  /** All nodes in recording order. */
  nodes: TraceNode[]
  /** All links in recording order. */
  links: TraceLink[]
  /** All change records in recording order. */
  changes: ChangeRecord[]
}

/** The persisted trace-service state. */
export interface TraceSnapshotState {
  /** Every scoped project. */
  scopes: TraceProjectState[]
}

/** The snapshot path for one data directory.
 * @param dataDir - the configured data directory.
 * @returns the snapshot file path.
 */
export function traceSnapshotPath(dataDir: string): string {
  return join(dataDir, TRACE_SNAPSHOT_NAME)
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

/** Read one optional string field; JSON null counts as absent. */
function optionalText(record: { [key: string]: unknown }, field: string, subject: string): string | undefined {
  const value = record[field]
  if (value === undefined || value === null) return undefined
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

/** Validate one restored trace node. */
function validateNode(value: unknown, subject: string): TraceNode {
  if (!isRecord(value)) throw new Error(`${subject} node must be an object`)
  const kind = value['kind']
  if (typeof kind !== 'string' || !TRACE_NODE_KINDS.includes(kind as TraceNodeKind)) {
    throw new Error(`${subject} node kind must be one of ${TRACE_NODE_KINDS.join(', ')}`)
  }
  const tags = value['tags']
  if (!Array.isArray(tags) || tags.some((tag: unknown) => typeof tag !== 'string')) {
    throw new Error(`${subject} node tags must be an array of strings`)
  }
  const detail = optionalText(value, 'detail', subject)
  const basis = optionalText(value, 'basis', subject)
  return {
    id: TraceNodeId(requiredText(value, 'id', subject)),
    kind: kind as TraceNodeKind,
    title: requiredText(value, 'title', subject),
    ...(detail === undefined ? {} : { detail }),
    tags: tags as string[],
    author: requiredText(value, 'author', subject),
    ...(basis === undefined ? {} : { basis }),
    createdAt: nonNegativeNumber(value, 'createdAt', subject),
    changeVersion: nonNegativeNumber(value, 'changeVersion', subject),
  }
}

/** Validate one restored trace link. */
function validateLink(value: unknown, subject: string): TraceLink {
  if (!isRecord(value)) throw new Error(`${subject} link must be an object`)
  const kind = value['kind']
  if (typeof kind !== 'string' || !TRACE_LINK_KINDS.includes(kind as TraceLinkKind)) {
    throw new Error(`${subject} link kind must be one of ${TRACE_LINK_KINDS.join(', ')}`)
  }
  return {
    from: TraceNodeId(requiredText(value, 'from', subject)),
    to: TraceNodeId(requiredText(value, 'to', subject)),
    kind: kind as TraceLinkKind,
  }
}

/** Validate one restored change record. */
function validateChange(value: unknown, subject: string): ChangeRecord {
  if (!isRecord(value)) throw new Error(`${subject} change must be an object`)
  const nodeIds = value['nodeIds']
  if (!Array.isArray(nodeIds) || nodeIds.length === 0
    || nodeIds.some((id: unknown) => typeof id !== 'string' || id.trim().length === 0)) {
    throw new Error(`${subject} change nodeIds must be a non-empty array of non-empty strings`)
  }
  return {
    nodeIds: (nodeIds as string[]).map(TraceNodeId),
    author: requiredText(value, 'author', subject),
    reason: requiredText(value, 'reason', subject),
    recordedAt: nonNegativeNumber(value, 'recordedAt', subject),
  }
}

/** Validate one restored scoped project. */
function validateScope(value: unknown, subject: string): TraceProjectState {
  if (!isRecord(value)) throw new Error(`${subject} scope must be an object`)
  const scope = requiredText(value, 'scope', subject)
  const ordinal = nonNegativeNumber(value, 'ordinal', subject)
  const nodesValue = value['nodes']
  if (!Array.isArray(nodesValue)) throw new Error(`${subject} field "nodes" must be an array`)
  const nodes = nodesValue.map((entry, index) => validateNode(entry, `${subject} node #${index}`))
  const linksValue = value['links']
  if (!Array.isArray(linksValue)) throw new Error(`${subject} field "links" must be an array`)
  const links = linksValue.map((entry, index) => validateLink(entry, `${subject} link #${index}`))
  const changesValue = value['changes']
  if (!Array.isArray(changesValue)) throw new Error(`${subject} field "changes" must be an array`)
  const changes = changesValue.map((entry, index) => validateChange(entry, `${subject} change #${index}`))
  const known = new Set(nodes.map(node => node.id))
  for (const link of links) {
    if (!known.has(link.from) || !known.has(link.to)) {
      throw new Error(`${subject} link references a node outside this scope`)
    }
  }
  for (const record of changes) {
    for (const id of record.nodeIds) {
      if (!known.has(id)) throw new Error(`${subject} change references a node outside this scope`)
    }
  }
  return { scope, ordinal, nodes, links, changes }
}

/**
 * Load the trace snapshot: `undefined` for a fresh store, or the validated
 * state. Corrupt, wrong-version, or malformed snapshots throw and name the
 * file — a store never silently degrades.
 * @param dataDir - the configured data directory.
 * @returns the restored state, or `undefined` when no snapshot exists.
 */
export function loadTraceSnapshot(dataDir: string): TraceSnapshotState | undefined {
  const file = traceSnapshotPath(dataDir)
  const raw = readJsonSnapshot(file, TRACE_SNAPSHOT_VERSION)
  if (raw === undefined) return undefined
  const subject = `iaTrace snapshot ${file}`
  if (!isRecord(raw)) throw new Error(`${subject} state must be an object`)
  const scopesValue = raw['scopes']
  if (!Array.isArray(scopesValue)) throw new Error(`${subject} field "scopes" must be an array`)
  const scopes = scopesValue.map((entry, index) => validateScope(entry, `${subject} scope #${index}`))
  const names = new Set(scopes.map(entry => entry.scope))
  if (names.size !== scopes.length) throw new Error(`${subject} contains duplicate scope keys`)
  return { scopes }
}

/**
 * Persist the trace state as one atomic snapshot.
 * @param dataDir - the configured data directory.
 * @param state - the complete current state.
 */
export function saveTraceSnapshot(dataDir: string, state: TraceSnapshotState): void {
  writeJsonSnapshot(traceSnapshotPath(dataDir), TRACE_SNAPSHOT_VERSION, state)
}
