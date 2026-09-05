/**
 * Traceability service — the design's single-source-of-truth graph. Projects
 * are isolated by a caller-chosen scope key (the agent's session id in the
 * tool consumer); each project is append-only, and change records feed the
 * three-level impact analysis. Model visibility flows through tool results,
 * never through this service directly.
 * @module @deepseek-ai/dsh-ia-trace
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  ChangeRecord,
  ImpactAnalysis,
  MatrixRow,
  TraceLink,
  TraceLinkKind,
  TraceNode,
  TraceNodeKind,
} from './types.ts'
import { TraceNodeId, DuplicateTraceLinkError, UnknownTraceNodeError } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    iaTrace: IaTraceService
  }
}

/** Input for recording one trace node. */
export interface AddNodeInput {
  /** Node kind, one of the five lifecycle kinds. */
  kind: TraceNodeKind
  /** Short human-readable title. */
  title: string
  /** Optional longer description. */
  detail?: string
  /** Free-form classification tags (default empty). */
  tags?: string[]
  /** Recording identity: agent or human name. */
  author: string
  /** Optional source citation or evidence reference. */
  basis?: string
}

/** Input for recording one change request. */
export interface RecordChangeInput {
  /** Ids of the nodes this change modifies. */
  nodeIds: TraceNodeId[]
  /** Requesting identity: agent or human name. */
  author: string
  /** Why the change is made. */
  reason: string
}

/**
 * One scoped, append-only trace graph. Nodes, links, and change records are
 * added only; supersession happens through new change records, never edits.
 */
export class TraceProject {
  private readonly nodes = new Map<TraceNodeId, TraceNode>()
  private readonly links: TraceLink[] = []
  private readonly changes: ChangeRecord[] = []
  private ordinal = 0
  private readonly listeners = new Set<(project: TraceProject) => void>()

  /**
   * Record one node into the project.
   * @param input - the node fields; the service issues the id.
   * @returns the recorded node.
   */
  addNode(input: AddNodeInput): TraceNode {
    if (input.title.trim().length === 0) {
      throw new Error('iaTrace: node `title` must be a non-empty string')
    }
    if (input.author.trim().length === 0) {
      throw new Error('iaTrace: node `author` must be a non-empty string')
    }
    const node: TraceNode = {
      id: TraceNodeId(`node-${this.ordinal + 1}`),
      kind: input.kind,
      title: input.title.trim(),
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
      tags: [...input.tags ?? []],
      author: input.author.trim(),
      ...(input.basis !== undefined ? { basis: input.basis } : {}),
      createdAt: Date.now(),
      changeVersion: 0,
    }
    this.ordinal += 1
    this.nodes.set(node.id, node)
    this.notify()
    return node
  }

  /**
   * Add one directed edge; both endpoints must exist and the edge must be new.
   * @param from - the source node id.
   * @param to - the target node id.
   * @param kind - the edge kind.
   * @returns the recorded edge.
   */
  addLink(from: TraceNodeId, to: TraceNodeId, kind: TraceLinkKind): TraceLink {
    if (!this.nodes.has(from)) throw new UnknownTraceNodeError(from)
    if (!this.nodes.has(to)) throw new UnknownTraceNodeError(to)
    const existing = this.links.some(link => link.from === from && link.to === to && link.kind === kind)
    if (existing) throw new DuplicateTraceLinkError(from, to, kind)
    const link: TraceLink = { from, to, kind }
    this.links.push(link)
    this.notify()
    return link
  }

  /**
   * Record one change request: bumps the touched nodes' change versions,
   * appends the record, and returns the forward impact analysis.
   * @param input - the change fields.
   * @returns the recorded change and its impact analysis.
   */
  recordChange(input: RecordChangeInput): { record: ChangeRecord; impact: ImpactAnalysis } {
    if (input.nodeIds.length === 0) {
      throw new Error('iaTrace: a change must name at least one node')
    }
    for (const id of input.nodeIds) {
      if (!this.nodes.has(id)) throw new UnknownTraceNodeError(id)
    }
    if (input.author.trim().length === 0) {
      throw new Error('iaTrace: change `author` must be a non-empty string')
    }
    const record: ChangeRecord = {
      nodeIds: [...input.nodeIds],
      author: input.author.trim(),
      reason: input.reason.trim().length > 0 ? input.reason.trim() : '(no reason recorded)',
      recordedAt: Date.now(),
    }
    for (const id of record.nodeIds) {
      const node = this.nodes.get(id)
      if (node === undefined) throw new UnknownTraceNodeError(id)
      node.changeVersion += 1
    }
    this.changes.push(record)
    const impact = this.impactOf(record.nodeIds)
    this.notify()
    return { record, impact }
  }

  /**
   * List every recorded node.
   * @returns all nodes in recording order.
   */
  nodesList(): TraceNode[] {
    return [...this.nodes.values()]
  }

  /**
   * List every recorded edge.
   * @returns all links in recording order.
   */
  linksList(): TraceLink[] {
    return [...this.links]
  }

  /**
   * List every recorded change.
   * @returns all change records in recording order.
   */
  changesList(): ChangeRecord[] {
    return [...this.changes]
  }

  /**
   * Read one node by id.
   * @param id - the node id to read.
   * @returns the node, or `undefined` when the id is unknown.
   */
  node(id: TraceNodeId): TraceNode | undefined {
    return this.nodes.get(id)
  }

  /**
   * Compute the three-level impact of changing the given nodes: forward
   * traversal marks direct successors, deeper transitive successors, and
   * tag-sharing unreachable nodes as potential impacts.
   * @param nodeIds - the changed node ids.
   * @returns the three-level analysis.
   */
  impactOf(nodeIds: readonly TraceNodeId[]): ImpactAnalysis {
    const successors = new Map<TraceNodeId, Set<TraceNodeId>>()
    for (const link of this.links) {
      let set = successors.get(link.from)
      if (set === undefined) {
        set = new Set()
        successors.set(link.from, set)
      }
      set.add(link.to)
    }
    const direct = new Set<TraceNodeId>()
    const reachable = new Set<TraceNodeId>(nodeIds)
    for (const id of nodeIds) {
      for (const next of successors.get(id) ?? []) {
        direct.add(next)
        reachable.add(next)
      }
    }
    const queue = [...direct]
    while (queue.length > 0) {
      const current = queue.shift()
      if (current === undefined) break
      for (const next of successors.get(current) ?? []) {
        if (!reachable.has(next)) {
          reachable.add(next)
          queue.push(next)
        }
      }
    }
    const indirect = [...reachable].filter(id => !nodeIds.includes(id) && !direct.has(id))
    const affectedTags = new Set<string>()
    for (const id of reachable) {
      const node = this.nodes.get(id)
      if (node !== undefined) for (const tag of node.tags) affectedTags.add(tag)
    }
    const potential: TraceNodeId[] = []
    for (const node of this.nodes.values()) {
      if (reachable.has(node.id)) continue
      if (node.tags.some(tag => affectedTags.has(tag))) potential.push(node.id)
    }
    return {
      changed: [...nodeIds],
      direct: [...direct],
      indirect,
      potential,
    }
  }

  /**
   * Project the traceability matrix: per requirement, its reachable
   * implementations and tests, plus the coverage verdict.
   * @returns one matrix row per requirement node, in recording order.
   */
  matrix(): MatrixRow[] {
    const rows: MatrixRow[] = []
    for (const node of this.nodes.values()) {
      if (node.kind !== 'requirement') continue
      const reachable = this.reachableFrom(node.id)
      const downstream = [...reachable].map(id => this.nodes.get(id))
        .filter((candidate): candidate is TraceNode => candidate !== undefined)
      const implementations = downstream.filter(candidate => candidate.kind === 'implementation')
      const tests = downstream.filter(candidate => candidate.kind === 'test')
      rows.push({
        requirement: node,
        implementations,
        tests,
        covered: implementations.length > 0 && tests.length > 0,
      })
    }
    return rows
  }

  /** Every node reachable from one node by following outgoing edges. */
  private reachableFrom(start: TraceNodeId): Set<TraceNodeId> {
    const successors = new Map<TraceNodeId, TraceNodeId[]>()
    for (const link of this.links) {
      const list = successors.get(link.from) ?? []
      list.push(link.to)
      successors.set(link.from, list)
    }
    const visited = new Set<TraceNodeId>()
    const queue: TraceNodeId[] = [start]
    while (queue.length > 0) {
      const current = queue.shift()
      if (current === undefined) break
      if (visited.has(current)) continue
      visited.add(current)
      queue.push(...successors.get(current) ?? [])
    }
    visited.delete(start)
    return visited
  }

  /**
   * Subscribe to post-mutation notifications.
   * @param listener - called after every committed mutation.
   * @returns a disposer removing the subscription.
   */
  onMutate(listener: (project: TraceProject) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Publish a mutation to listeners after it has committed. */
  private notify(): void {
    for (const listener of this.listeners) listener(this)
  }
}

/**
 * The traceability service. It owns no project state itself — callers open
 * per-scope projects through {@link IaTraceService.project} — but keeps the
 * scoped projects alive until the service disposes.
 */
export class IaTraceService extends Service {
  private readonly projects = new Map<string, TraceProject>()
  private readonly openListeners = new Set<(project: TraceProject) => void>()

  /**
   * Create the trace service.
   * @param ctx - Cordis context that owns the service.
   */
  constructor(ctx: Context) {
    super(ctx, 'iaTrace')
    // Projects and open-listeners live as long as the service; the effect
    // disposer releases them together.
    ctx.effect(() => () => {
      this.projects.clear()
      this.openListeners.clear()
    })
  }

  /**
   * Open (or reuse) the project isolated under one scope key.
   * @param scope - the caller-chosen isolation key, e.g. the agent's session id.
   * @returns the scoped project.
   */
  project(scope: string): TraceProject {
    let project = this.projects.get(scope)
    if (project === undefined) {
      project = new TraceProject()
      this.projects.set(scope, project)
      for (const listener of this.openListeners) listener(project)
    }
    return project
  }

  /**
   * Subscribe to first-open notifications; the registration lives as long as
   * the service (used by the invariant companion to attach validation).
   * @param listener - called once per newly opened project, after it commits.
   */
  onProjectOpen(listener: (project: TraceProject) => void): void {
    this.openListeners.add(listener)
  }

  /**
   * Check whether one scope key has a project.
   * @param scope - the isolation key to check.
   * @returns whether the scope key already has a project.
   */
  hasProject(scope: string): boolean {
    return this.projects.has(scope)
  }
}

export default IaTraceService
export * from './types.ts'
