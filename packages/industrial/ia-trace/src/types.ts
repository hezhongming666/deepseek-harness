/**
 * Shared vocabulary of the traceability layer: node and link kinds, the
 * change-request record, and the three-level impact analysis.
 * @module @deepseek-ai/dsh-ia-trace
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque id of one trace node, issued by the trace service. */
export type TraceNodeId = Branded<'TraceNodeId'>

/**
 * Brand a string as a {@link TraceNodeId}.
 * @param value - the opaque node identifier.
 * @returns the same string, branded; no validation is performed.
 */
export function TraceNodeId(value: string): TraceNodeId {
  return value as TraceNodeId
}

/** The five trace node kinds of the engineering loop. */
export type TraceNodeKind = 'requirement' | 'design' | 'implementation' | 'test' | 'change'

/** Closed set of node kinds, as a runtime value for input validation. */
export const TRACE_NODE_KINDS: readonly TraceNodeKind[] = ['requirement', 'design', 'implementation', 'test', 'change']

/** One append-only trace record: an engineering item with provenance. */
export interface TraceNode {
  /** Service-issued opaque id. */
  id: TraceNodeId
  /** Node kind, one of the five lifecycle kinds. */
  kind: TraceNodeKind
  /** Short human-readable title. */
  title: string
  /** Optional longer description or structured detail. */
  detail?: string
  /** Free-form classification tags shared by related nodes. */
  tags: string[]
  /** Who recorded the node — an agent or human identity string. */
  author: string
  /** Optional source citation or evidence reference behind the record. */
  basis?: string
  /** Epoch milliseconds when the node was recorded. */
  createdAt: number
  /** Number of change records that have touched this node; starts at 0. */
  changeVersion: number
}

/**
 * Typed edges of the trace graph, directed `from → to`. The kinds follow the
 * engineering loop: designs derive from requirements, implementations
 * implement designs, tests verify either, changes modify existing nodes.
 */
export type TraceLinkKind = 'derives' | 'implements' | 'verifies' | 'changes'

/** Closed set of link kinds, as a runtime value for input validation. */
export const TRACE_LINK_KINDS: readonly TraceLinkKind[] = ['derives', 'implements', 'verifies', 'changes']

/** One directed trace edge. */
export interface TraceLink {
  /** Source node id. */
  from: TraceNodeId
  /** Target node id. */
  to: TraceNodeId
  /** Edge kind. */
  kind: TraceLinkKind
}

/** One change-request record: who changed what, why, and on whose authority. */
export interface ChangeRecord {
  /** Ids of the nodes this change modified. */
  nodeIds: TraceNodeId[]
  /** Who requested the change — agent or human identity. */
  author: string
  /** Why the change was made. */
  reason: string
  /** Epoch milliseconds when the change was recorded. */
  recordedAt: number
}

/**
 * Three-level change impact, computed by forward traversal from the changed
 * nodes: direct successors are directly affected, transitive successors are
 * indirectly affected, and tag-sharing unreachable nodes are potential
 * (model-assisted, human-confirmed) impacts.
 */
export interface ImpactAnalysis {
  /** Ids of the nodes the change touched. */
  changed: TraceNodeId[]
  /** Immediate successors of the changed nodes — artifacts to regenerate. */
  direct: TraceNodeId[]
  /** Transitive successors beyond the direct level — artifacts to re-verify. */
  indirect: TraceNodeId[]
  /** Tag-sharing but unreachable nodes — review candidates, advisory only. */
  potential: TraceNodeId[]
}

/** One requirement row of the traceability matrix. */
export interface MatrixRow {
  /** The requirement node. */
  requirement: TraceNode
  /** Implementation nodes reachable from the requirement. */
  implementations: TraceNode[]
  /** Test nodes reachable from the requirement. */
  tests: TraceNode[]
  /** Whether the requirement has at least one implementation and one test. */
  covered: boolean
}

/** Error thrown when a trace mutation references an unknown node. */
export class UnknownTraceNodeError extends Error {
  /** Stable machine-readable error code. */
  readonly code = 'IA_TRACE_UNKNOWN_NODE' as const

  /**
   * Construct the error naming the missing node.
   * @param id - the unresolved node id.
   */
  constructor(id: TraceNodeId) {
    super(`unknown trace node ${JSON.stringify(String(id))}`)
    this.name = 'UnknownTraceNodeError'
  }
}

/** Error thrown when a link would duplicate an existing edge. */
export class DuplicateTraceLinkError extends Error {
  /** Stable machine-readable error code. */
  readonly code = 'IA_TRACE_DUPLICATE_LINK' as const

  /**
   * Construct the error naming the duplicate edge.
   * @param from - the source node id.
   * @param to - the target node id.
   * @param kind - the link kind.
   */
  constructor(from: TraceNodeId, to: TraceNodeId, kind: TraceLinkKind) {
    super(`duplicate trace link ${String(from)} -${kind}-> ${String(to)}`)
    this.name = 'DuplicateTraceLinkError'
  }
}
