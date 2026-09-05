/**
 * Knowledge service — the design's standards/templates/cases libraries with
 * the cold-start readiness gate. Every entry carries a mandatory source and
 * version citation; retrieval is deterministic keyword matching, never a
 * model call, so hits are reproducible and attributable. Learning-sink
 * records enter `pending-review` and wait for a human approval.
 * @module @deepseek-ai/dsh-ia-knowledge
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { DuplicateKnowledgeEntryError, KnowledgeEntryId, MissingCitationError } from './types.ts'
import type {
  KnowledgeEntry,
  LibraryKind,
  Readiness,
  ReviewStatus,
  SearchHit,
  SearchResult,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    iaKnowledge: IaKnowledgeService
  }
}

/**
 * Knowledge service configuration: the cold-start minimum scales and the
 * retrieval result cap.
 */
export interface Config {
  /** Minimum approved+reviewing template entries for cold-start (§6.2, default 20). */
  minTemplates?: number
  /** Minimum case entries for cold-start (§6.2, default 30). */
  minCases?: number
  /** Maximum hits one retrieval returns (default 10). */
  maxSearchResults?: number
}

/** Schemastery configuration for the knowledge service. */
export const Config: Schema<Config> = z.object({
  minTemplates: z.number().default(20),
  minCases: z.number().default(30),
  maxSearchResults: z.number().default(10),
})

/** Input for recording one knowledge entry. */
export interface RecordEntryInput {
  /** Owning library. */
  library: LibraryKind
  /** Short human-readable title. */
  title: string
  /** The entry body. */
  content: string
  /** Classification tags (default empty). */
  tags?: string[]
  /** Mandatory citation source. */
  source: string
  /** Mandatory cited source version. */
  version: string
  /** Recording identity: agent or human name. */
  recordedBy: string
  /** Review status; the learning sink records `pending-review`. */
  reviewStatus: ReviewStatus
}

/**
 * The knowledge service. Entries are append-only records keyed per library;
 * duplicate title+content records are rejected so the learning pipeline
 * cannot pollute a library twice.
 */
export class IaKnowledgeService extends Service {
  static Config: Schema<Config> = Config

  private readonly entries = new Map<KnowledgeEntryId, KnowledgeEntry>()
  private readonly minTemplates: number
  private readonly minCases: number
  private readonly maxSearchResults: number
  private ordinal = 0
  private readonly listeners = new Set<() => void>()

  /**
   * Create the knowledge service with validated thresholds.
   * @param ctx - Cordis context that owns the service.
   * @param config - the cold-start minima and the retrieval cap.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'iaKnowledge')
    this.minTemplates = requirePositiveInteger(config.minTemplates ?? 20, 'minTemplates')
    this.minCases = requirePositiveInteger(config.minCases ?? 30, 'minCases')
    this.maxSearchResults = requirePositiveInteger(config.maxSearchResults ?? 10, 'maxSearchResults')
  }

  /**
   * Record one entry. Duplicate title+content pairs in one library are
   * rejected, and citations are mandatory — the design's evidence rule.
   * @param input - the entry to record.
   * @returns the recorded entry.
   */
  record(input: RecordEntryInput): KnowledgeEntry {
    const title = input.title.trim()
    const content = input.content.trim()
    const source = input.source.trim()
    const version = input.version.trim()
    if (title.length === 0) throw new Error('iaKnowledge: entry `title` must be non-empty')
    if (content.length === 0) throw new Error('iaKnowledge: entry `content` must be non-empty')
    if (source.length === 0) throw new MissingCitationError('source')
    if (version.length === 0) throw new MissingCitationError('version')
    if (input.recordedBy.trim().length === 0) throw new Error('iaKnowledge: `recordedBy` must be non-empty')
    for (const existing of this.entries.values()) {
      if (existing.library === input.library && existing.title === title && existing.content === content) {
        throw new DuplicateKnowledgeEntryError(input.library, title, existing.id)
      }
    }
    this.ordinal += 1
    const entry: KnowledgeEntry = {
      id: KnowledgeEntryId(`entry-${this.ordinal}`),
      library: input.library,
      title,
      content,
      tags: [...input.tags ?? []],
      source,
      version,
      reviewStatus: input.reviewStatus,
      recordedBy: input.recordedBy.trim(),
      recordedAt: Date.now(),
    }
    this.entries.set(entry.id, entry)
    this.notify()
    return entry
  }

  /**
   * Approve one pending entry — the human quality-gate path (§6.2 抽检).
   * @param id - the entry to approve.
   * @returns the updated entry.
   * @throws when the id is unknown or the entry is already approved.
   */
  approveEntry(id: KnowledgeEntryId): KnowledgeEntry {
    const entry = this.entries.get(id)
    if (entry === undefined) throw new Error(`iaKnowledge: unknown entry ${String(id)}`)
    if (entry.reviewStatus === 'approved') throw new Error(`iaKnowledge: entry ${String(id)} is already approved`)
    entry.reviewStatus = 'approved'
    this.notify()
    return entry
  }

  /** List the entries of one library.
   * @param library - the library to list.
   * @returns all entries of the library, in recording order. */
  entriesList(library: LibraryKind): KnowledgeEntry[] {
    return [...this.entries.values()].filter(entry => entry.library === library)
  }

  /**
   * List the closed library kinds.
   * @returns the three library kinds, in canonical order.
   */
  libraries(): LibraryKind[] {
    return ['standards', 'templates', 'cases']
  }

  /**
   * Deterministic keyword retrieval over one library: every query term must
   * match somewhere in the entry, hits are ranked by total match count and
   * capped at the configured maximum.
   * @param library - the library to search.
   * @param query - whitespace-separated search terms.
   * @returns the bounded hits plus the cold-start degradation flag.
   */
  search(library: LibraryKind, query: string): SearchResult {
    const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(term => term.length > 0))]
    if (terms.length === 0) return { hits: [], degraded: !this.readiness().ready }
    const scored: { hit: SearchHit; score: number }[] = []
    for (const entry of this.entriesList(library)) {
      const haystack = `${entry.title}\n${entry.content}\n${entry.tags.join(' ')}`.toLowerCase()
      const matchedTerms = terms.filter(term => haystack.includes(term))
      if (matchedTerms.length !== terms.length) continue
      let score = 0
      for (const term of matchedTerms) score += haystack.split(term).length - 1
      scored.push({ hit: { entry, matchedTerms }, score })
    }
    scored.sort((a, b) => b.score - a.score || a.hit.entry.id.localeCompare(b.hit.entry.id))
    return {
      hits: scored.slice(0, this.maxSearchResults).map(item => item.hit),
      degraded: !this.readiness().ready,
    }
  }

  /** Snapshot the cold-start readiness.
   * @returns the cold-start readiness snapshot (§6.2 minimum scales). */
  readiness(): Readiness {
    const counts: Record<LibraryKind, number> = {
      standards: this.entriesList('standards').length,
      templates: this.entriesList('templates').length,
      cases: this.entriesList('cases').length,
    }
    const gaps: Readiness['gaps'] = []
    if (counts.templates < this.minTemplates) {
      gaps.push({ library: 'templates', have: counts.templates, need: this.minTemplates })
    }
    if (counts.cases < this.minCases) {
      gaps.push({ library: 'cases', have: counts.cases, need: this.minCases })
    }
    return { ready: gaps.length === 0, counts, gaps }
  }

  /** Subscribe to post-mutation notifications; the registration lives as long as the service.
   * @param listener - called after every committed mutation. */
  onMutate(listener: () => void): void {
    this.listeners.add(listener)
  }

  /** Publish a mutation to listeners after it has committed. */
  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

/** Validate one positive-integer config field, failing loud at load. */
function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`iaKnowledge: ${field} must be a positive integer, got ${value}`)
  }
  return value
}

export default IaKnowledgeService
export * from './types.ts'
