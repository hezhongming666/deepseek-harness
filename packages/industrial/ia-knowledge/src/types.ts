/**
 * Shared vocabulary of the knowledge layer: the three libraries, entries
 * with mandatory citations, search hits, and cold-start readiness.
 * @module @deepseek-ai/dsh-ia-knowledge
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque id of one knowledge entry, issued by the knowledge service. */
export type KnowledgeEntryId = Branded<'KnowledgeEntryId'>

/**
 * Brand a string as a {@link KnowledgeEntryId}.
 * @param value - the opaque entry identifier.
 * @returns the same string, branded; no validation is performed.
 */
export function KnowledgeEntryId(value: string): KnowledgeEntryId {
  return value as KnowledgeEntryId
}

/** The three libraries of the knowledge layer. */
export type LibraryKind = 'standards' | 'templates' | 'cases'

/** Closed set of library kinds, as a runtime value for input validation. */
export const LIBRARY_KINDS: readonly LibraryKind[] = ['standards', 'templates', 'cases']

/** Review status of one entry: learning-sink records start pending review. */
export type ReviewStatus = 'pending-review' | 'approved'

/** One knowledge entry with its mandatory citation. */
export interface KnowledgeEntry {
  /** Service-issued opaque id. */
  id: KnowledgeEntryId
  /** Owning library. */
  library: LibraryKind
  /** Short human-readable title. */
  title: string
  /** The entry body — a clause, a program template, or a case description. */
  content: string
  /** Classification tags for retrieval and impact correlation. */
  tags: string[]
  /** The citation source — clause number, project, or document reference. */
  source: string
  /** The cited source's version or revision. */
  version: string
  /** `pending-review` until a human approves; learning-sink records start here. */
  reviewStatus: ReviewStatus
  /** Who recorded the entry — an agent or human identity. */
  recordedBy: string
  /** Epoch milliseconds when the entry was recorded. */
  recordedAt: number
}

/** One retrieval hit: the entry plus the terms that matched. */
export interface SearchHit {
  /** The matched entry, with its citation. */
  entry: KnowledgeEntry
  /** The query terms that matched this entry. */
  matchedTerms: string[]
}

/** One retrieval result: bounded hits plus the cold-start degradation flag. */
export interface SearchResult {
  /** The matched entries, at most the configured result cap. */
  hits: SearchHit[]
  /**
   * True when the libraries are below the cold-start minimum scale (§6.2):
   * retrieval runs in pure-generation mode and the consumer must say so.
   */
  degraded: boolean
}

/** One library's scale relative to its cold-start minimum. */
export interface LibraryGap {
  /** The library below its minimum. */
  library: LibraryKind
  /** Entries present. */
  have: number
  /** Minimum scale required. */
  need: number
}

/** Cold-start readiness snapshot of the knowledge layer. */
export interface Readiness {
  /** Whether every configured minimum is met. */
  ready: boolean
  /** Per-library entry counts. */
  counts: Record<LibraryKind, number>
  /** Libraries below their configured minimum. */
  gaps: LibraryGap[]
}

/** Error thrown when a recorded entry duplicates an existing one. */
export class DuplicateKnowledgeEntryError extends Error {
  /** Stable machine-readable error code. */
  readonly code = 'IA_KNOWLEDGE_DUPLICATE_ENTRY' as const

  /**
   * Construct the error naming the duplicate.
   * @param library - the owning library.
   * @param title - the duplicate title.
   * @param existing - the id of the existing entry.
   */
  constructor(library: LibraryKind, title: string, existing: KnowledgeEntryId) {
    super(`duplicate ${library} entry ${JSON.stringify(title)}; existing entry ${String(existing)}`)
    this.name = 'DuplicateKnowledgeEntryError'
  }
}

/** Error thrown when a citation (source or version) is missing. */
export class MissingCitationError extends Error {
  /** Stable machine-readable error code. */
  readonly code = 'IA_KNOWLEDGE_MISSING_CITATION' as const

  /**
   * Construct the error naming the missing citation field.
   * @param field - the missing field name.
   */
  constructor(field: 'source' | 'version') {
    super(`knowledge entries need a non-empty ${field} citation`)
    this.name = 'MissingCitationError'
  }
}
