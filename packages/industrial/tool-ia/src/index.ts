/**
 * Model-facing industrial-automation tools: the agent surface of the closed
 * loop. `ia_verify` runs the deterministic validators, `ia_trace` maintains
 * the traceability graph, `ia_gate` requests gate decisions (never decides),
 * `ia_knowledge` searches and feeds the learning sink, and `ia_project` drives
 * the orchestrator DAG. The authority boundary is structural: no tool schema
 * exposes a decide, approve, or escalation-resolution action.
 * @module @deepseek-ai/dsh-tool-ia
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TraceNodeId, TRACE_LINK_KINDS, TRACE_NODE_KINDS } from '@deepseek-ai/dsh-ia-trace'
import { LIBRARY_KINDS } from '@deepseek-ai/dsh-ia-knowledge'
import { ProjectId, StageId } from '@deepseek-ai/dsh-ia-orchestrator'
import type { StageSnapshot } from '@deepseek-ai/dsh-ia-orchestrator'
import { GateId } from '@deepseek-ai/dsh-ia-gates'
import type { VerificationReport } from '@deepseek-ai/dsh-ia-verifier'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Stable Cordis plugin name. */
export const name = 'tool-ia'
/** The industrial services the tools dispatch into. */
export const inject = ['tools', 'iaVerifiers', 'iaGates', 'iaTrace', 'iaKnowledge', 'iaOrchestrator']

/** Tool package configuration. */
export interface Config {
  /** Which tools to register; every omitted name stays unregistered (default: all five). */
  enabled?: string[]
}

/** Schemastery configuration for the tool package. */
export const Config: z<Config> = z.object({
  enabled: z.array(z.string()).default(['ia_verify', 'ia_trace', 'ia_gate', 'ia_knowledge', 'ia_project']),
})

/** JSON-serializable digest of one verification report for tool output. */
function reportOutput(report: VerificationReport) {
  return {
    kind: report.kind,
    pass: report.pass,
    diagnostics: report.diagnostics.map(diagnostic => ({
      code: diagnostic.code,
      message: diagnostic.message,
      severity: diagnostic.severity,
      ...(diagnostic.position !== undefined ? { position: diagnostic.position } : {}),
    })),
    evidence: report.evidence.map(item => ({
      kind: item.kind,
      summary: item.summary,
      ...(item.detail !== undefined ? { detail: item.detail } : {}),
    })),
  }
}

/** JSON-serializable digest of one trace node for tool output. */
function nodeOutput(node: {
  id: unknown
  kind: string
  title: string
  detail?: string
  tags: string[]
  author: string
  basis?: string
  createdAt: number
  changeVersion: number
}) {
  return {
    id: String(node.id),
    kind: node.kind,
    title: node.title,
    ...(node.detail !== undefined ? { detail: node.detail } : {}),
    tags: node.tags,
    author: node.author,
    ...(node.basis !== undefined ? { basis: node.basis } : {}),
    createdAt: node.createdAt,
    changeVersion: node.changeVersion,
  }
}

/** JSON-serializable digest of one impact analysis for tool output. */
function impactOutput(impact: { changed: unknown[]; direct: unknown[]; indirect: unknown[]; potential: unknown[] }) {
  return {
    changed: impact.changed.map(String),
    direct: impact.direct.map(String),
    indirect: impact.indirect.map(String),
    potential: impact.potential.map(String),
  }
}

/** One deterministic text content block from joined lines. */
function textBlock(lines: string[]): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Read one scalar field of a JSON digest as text. */
function fieldText(record: Record<string, JsonValue>, field: string, fallback = ''): string {
  const value = record[field]
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

/** Join the string members of one JSON array field. */
function fieldList(value: JsonValue | undefined): string {
  if (!Array.isArray(value)) return ''
  return value.filter((item): item is string => typeof item === 'string').join(', ')
}

/** Join the `id` members of one JSON array of node digests. */
function fieldIdList(value: JsonValue | undefined): string {
  if (!Array.isArray(value)) return ''
  const ids: string[] = []
  for (const item of value) {
    if (typeof item === 'object' && item !== null) ids.push(fieldText(item as Record<string, JsonValue>, 'id'))
  }
  return ids.filter(id => id.length > 0).join(', ')
}

/** Render one `ia_trace` canonical value: node ids, links, impact, and matrix. */
function traceRender(value: { action: string; result: Record<string, JsonValue> }): { type: 'text'; text: string }[] {
  const result = value.result
  switch (value.action) {
    case 'record':
      return textBlock([`Trace ${fieldText(result, 'kind')} recorded: ${fieldText(result, 'id')} — ${fieldText(result, 'title')}`])
    case 'link':
      return textBlock([`Trace link: ${fieldText(result, 'from')} -${fieldText(result, 'kind')}-> ${fieldText(result, 'to')}`])
    case 'change':
    case 'impact': {
      const digest = (value.action === 'change' ? result['impact'] ?? {} : result) as Record<string, JsonValue>
      return textBlock([`Trace ${value.action}: changed=[${fieldList(digest['changed'])}] direct=[${fieldList(digest['direct'])}] indirect=[${fieldList(digest['indirect'])}] potential=[${fieldList(digest['potential'])}]`])
    }
    case 'matrix': {
      const rows = result['rows']
      if (!Array.isArray(rows) || rows.length === 0) return textBlock(['Trace matrix: no requirements recorded.'])
      const lines = ['Trace matrix:']
      for (const rowValue of rows) {
        const row = rowValue as Record<string, JsonValue>
        const requirement = (row['requirement'] ?? {}) as Record<string, JsonValue>
        lines.push(`- ${fieldText(requirement, 'id')} ${fieldText(requirement, 'title')}: implementations=[${fieldIdList(row['implementations'])}] tests=[${fieldIdList(row['tests'])}] covered=${row['covered'] === true}`)
      }
      return textBlock(lines)
    }
    default:
      return textBlock([`Trace ${value.action}: unhandled render action`])
  }
}

/** Render one `ia_gate` canonical value: the gate list or one request outcome. */
function gateRender(value: { action: string; result: Record<string, JsonValue> }): { type: 'text'; text: string }[] {
  const result = value.result
  if (value.action === 'list') {
    const gates = result['gates']
    if (!Array.isArray(gates) || gates.length === 0) return textBlock(['Gates: none registered.'])
    const lines = ['Gates:']
    for (const gateValue of gates) {
      const gate = gateValue as Record<string, JsonValue>
      const latest = gate['latestDecision']
      const latestText = typeof latest === 'object' && latest !== null
        ? fieldText(latest as Record<string, JsonValue>, 'outcome')
        : 'none'
      const human = gate['alwaysHuman'] === true ? ' [always-human]' : ''
      lines.push(`- ${fieldText(gate, 'id')}${human}: ${fieldText(gate, 'title')} | pending=${fieldText(gate, 'pendingRequests', '0')} | latest=${latestText}`)
    }
    return textBlock(lines)
  }
  const decided = result['decided'] === true
  const outcome = fieldText(result, 'outcome', 'pending')
  const decider = fieldText(result, 'decider')
  const note = fieldText(result, 'note')
  return textBlock([`Gate ${fieldText(result, 'gateId')}: ${decided ? outcome + (decider ? ` by ${decider}` : '') : 'pending'}${note ? ` — ${note}` : ''}`])
}

/** Render one `ia_knowledge` canonical value: hits with citations, records, readiness. */
function knowledgeRender(value: { action: string; result: Record<string, JsonValue> }): { type: 'text'; text: string }[] {
  const result = value.result
  switch (value.action) {
    case 'search': {
      const hits = result['hits']
      const hitCount = Array.isArray(hits) ? hits.length : 0
      const lines = [`Knowledge search: ${hitCount} hit(s)${result['degraded'] === true ? ' — degraded: libraries below cold-start minimum' : ''}`]
      if (Array.isArray(hits)) {
        for (const hitValue of hits) {
          const hit = hitValue as Record<string, JsonValue>
          const entry = (hit['entry'] ?? {}) as Record<string, JsonValue>
          const matched = fieldList(hit['matchedTerms'])
          lines.push(`- ${fieldText(entry, 'id')} [${fieldText(entry, 'library')}] ${fieldText(entry, 'title')} — source: ${fieldText(entry, 'source')} version: ${fieldText(entry, 'version')} (${fieldText(entry, 'reviewStatus')})${matched ? `; matched: ${matched}` : ''}`)
        }
      }
      return textBlock(lines)
    }
    case 'record':
      return textBlock([`Knowledge recorded: ${fieldText(result, 'id')} (${fieldText(result, 'reviewStatus')})`])
    case 'readiness': {
      const counts = (result['counts'] ?? {}) as Record<string, JsonValue>
      const lines = [`Knowledge readiness: ${result['ready'] === true ? 'ready' : 'not ready'} | cases=${fieldText(counts, 'cases', '0')} standards=${fieldText(counts, 'standards', '0')} templates=${fieldText(counts, 'templates', '0')}`]
      const gaps = result['gaps']
      if (Array.isArray(gaps)) {
        for (const gapValue of gaps) {
          const gap = gapValue as Record<string, JsonValue>
          lines.push(`- gap ${fieldText(gap, 'library')}: have ${fieldText(gap, 'have', '0')} / need ${fieldText(gap, 'need', '0')}`)
        }
      }
      return textBlock(lines)
    }
    default:
      return textBlock([`Knowledge ${value.action}: unhandled render action`])
  }
}

/** Render one project stage digest as one status line. */
function projectStageLine(stage: Record<string, JsonValue>): string {
  const parts = [`- ${fieldText(stage, 'id')} [${fieldText(stage, 'state')}] attempts=${fieldText(stage, 'attempts', '0')}/${fieldText(stage, 'maxRetries', '0')}`]
  const verifiers = fieldList(stage['verifiers'])
  parts.push(`verifiers=${verifiers || 'none'}`)
  const gate = fieldText(stage, 'gate')
  if (gate) {
    const gateStatus = fieldText(stage, 'gateStatus')
    parts.push(`gate=${gate}${gateStatus ? `(${gateStatus})` : ''}`)
  }
  const reports = stage['reports']
  if (Array.isArray(reports) && reports.length > 0) {
    parts.push(`reports=${reports.map((report) => {
      const digest = report as Record<string, JsonValue>
      return `${fieldText(digest, 'kind')}:${digest['pass'] === true ? 'pass' : 'fail'}`
    }).join(',')}`)
  }
  const escalation = stage['escalation']
  if (typeof escalation === 'object' && escalation !== null) {
    parts.push(`escalated: ${fieldText(escalation as Record<string, JsonValue>, 'failureSummary')}`)
  }
  const instruction = fieldText(stage, 'instruction')
  if (instruction) parts.push(`instruction: ${instruction}`)
  return parts.join(' ')
}

/** Render one `ia_project` canonical value: projects, snapshots, stage verdicts, audits. */
function projectRender(value: { action: string; result: Record<string, JsonValue> }): { type: 'text'; text: string }[] {
  const result = value.result
  switch (value.action) {
    case 'list': {
      const projects = result['projects']
      if (!Array.isArray(projects) || projects.length === 0) return textBlock(['Projects: none.'])
      const lines = ['Projects:']
      for (const projectValue of projects) {
        const project = projectValue as Record<string, JsonValue>
        lines.push(`- ${fieldText(project, 'id')} (${fieldText(project, 'template')})`)
      }
      return textBlock(lines)
    }
    case 'submit':
      return textBlock(['Project stage:', projectStageLine(result)])
    case 'export': {
      const stages = result['stages']
      const lines = [`Audit exported: project=${fieldText(result, 'projectId')} (${fieldText(result, 'template')})`]
      if (Array.isArray(stages)) {
        for (const stageValue of stages) {
          const stage = stageValue as Record<string, JsonValue>
          const requests = stage['gateRequests']
          const decisions = Array.isArray(requests)
            ? requests.map((requestValue) => {
              const decision = (requestValue as Record<string, JsonValue>)['decision']
              return typeof decision === 'object' && decision !== null
                ? fieldText(decision as Record<string, JsonValue>, 'outcome')
                : 'pending'
            }).join(',')
            : ''
          lines.push(`- ${fieldText(stage, 'stageId')} [${fieldText(stage, 'state')}] attempts=${fieldText(stage, 'attempts', '0')}/${fieldText(stage, 'maxRetries', '0')}${decisions ? ` gate=${decisions}` : ''}`)
        }
      }
      return textBlock(lines)
    }
    default: {
      const stages = result['stages']
      const lines = [`Project ${fieldText(result, 'id')} (${fieldText(result, 'template')}):`]
      if (Array.isArray(stages)) {
        for (const stageValue of stages) lines.push(projectStageLine(stageValue as Record<string, JsonValue>))
      }
      const instructions = result['instructions']
      if (Array.isArray(instructions)) {
        for (const item of instructions) {
          const digest = item as Record<string, JsonValue>
          lines.push(`instruction for ${fieldText(digest, 'stageId')}: ${fieldText(digest, 'instruction')}`)
        }
      }
      return textBlock(lines)
    }
  }
}

/**
 * Downcast one plain JSON object to the tool-result record the registry's
 * output schema demands; runtime validation still rejects non-JSON values.
 * @param value - the plain JSON object.
 * @returns the same value under the record type.
 */
function toResult(value: object): Record<string, JsonValue> {
  return value as Record<string, JsonValue>
}

/**
 * Register the five industrial tools on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry and the
 *   industrial services.
 * @param config - which tools to register.
 */
export function apply(ctx: Context, config: Config): void {
  const enabled = new Set(config.enabled ?? [])
  const verifierKinds = ctx.iaVerifiers.kinds()
  // The agent's current project id per agent; agents drive one project at a
  // time and may override it explicitly on every project tool.
  const currentProject = new WeakMap<Agent, ProjectId>()

  /** Resolve the project an agent action targets, or throw a clear error. */
  function projectOf(exec: ToolExecution, projectId?: string): ProjectId {
    if (projectId !== undefined && projectId.length > 0) return ProjectId(projectId)
    const agent = exec.agent
    const current = agent === undefined ? undefined : currentProject.get(agent)
    if (current === undefined) {
      throw new Error('ia_project: pass a `projectId` or init a project first')
    }
    return current
  }

  /** The calling agent's identity, or a fixed non-agent label. */
  function authorOf(exec: ToolExecution): string {
    return exec.agent === undefined ? 'non-agent-caller' : String(exec.agent.id)
  }

  /** The trace scope key: one isolated trace project per agent session. */
  function traceScopeOf(exec: ToolExecution): string {
    if (exec.agent === undefined) throw new Error('ia_trace requires an owning agent session')
    return String(exec.agent.session.id)
  }

  if (enabled.has('ia_verify')) {
    ctx.tools.register(defineTool({
      name: 'ia_verify',
      description:
        'Run one deterministic industrial-automation verifier over an artifact and return its pass/fail report with diagnostics and evidence. '
        + 'Verifiers are the adjudication layer: they are pure, reproducible checks (compiler-style syntax and lint checks, IO-symbol consistency), never model judgments. '
        + 'Use this before claiming any artifact is ready for the next project stage; a failed report must be repaired and re-verified.',
      parameters: {
        kind: {
          type: 'string',
          required: true,
          enum: [...verifierKinds],
          description: 'The verifier to run, one of the registered kinds.',
        },
        source: {
          type: 'string',
          required: true,
          description: 'The artifact text: Structured Text source for st-syntax/st-lint, TIA SCL source for tia-compile, the IO-symbol JSON document for io-consistency.',
        },
        vendorSource: {
          type: 'string',
          description: 'Optional vendor-dialect source for external compile validators such as tia-compile; the validator falls back to `source` when omitted.',
        },
        fileName: { type: 'string', description: 'Optional file name used only for diagnostic framing.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true },
            pass: { type: 'boolean', required: true },
            diagnostics: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  code: { type: 'string', required: true },
                  message: { type: 'string', required: true },
                  severity: { type: 'string', required: true, enum: ['error', 'warning'] },
                  position: {
                    type: 'object',
                    additionalProperties: false,
                    properties: { line: { type: 'integer', required: true }, column: { type: 'integer', required: true } },
                  },
                },
              },
            },
            evidence: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `${value.pass ? 'PASS' : 'FAIL'} ${value.kind}: ${value.diagnostics.length} finding(s).`,
        }],
      },
      async execute(args, _exec) {
        const report = await ctx.iaVerifiers.verify(args.kind, {
          text: args.source,
          ...(args.vendorSource !== undefined ? { vendorSource: args.vendorSource } : {}),
          ...(args.fileName !== undefined ? { fileName: args.fileName } : {}),
        })
        return reportOutput(report)
      },
      presentCall: args => ({ card: 'generic', title: `Verify ${args.kind}`, kind: 'other', rawInput: args.source }),
    }))
  }

  if (enabled.has('ia_trace')) {
    ctx.tools.register(defineTool({
      name: 'ia_trace',
      description:
        'Maintain the append-only traceability graph of the current project: record requirement/design/implementation/test/change nodes, link them with typed edges, record change requests, run the three-level change-impact analysis, and read the requirement matrix. '
        + 'Every requirement must end up linked to at least one implementation and one test (the matrix shows the coverage gap). Nodes are never edited — record a change request instead.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['record', 'link', 'change', 'impact', 'matrix'],
          description: 'Which trace operation to run.',
        },
        kind: { type: 'string', enum: [...TRACE_NODE_KINDS], description: 'Trace node kind: requirement | design | implementation | test | change (record).' },
        title: { type: 'string', description: 'Short node title (record).' },
        detail: { type: 'string', description: 'Optional longer description (record).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Classification tags (record).' },
        basis: { type: 'string', description: 'Source citation or evidence reference (record).' },
        from: { type: 'string', description: 'Source node id (link).' },
        to: { type: 'string', description: 'Target node id (link).' },
        linkKind: { type: 'string', enum: [...TRACE_LINK_KINDS], description: 'Edge kind: derives | implements | verifies | changes (link).' },
        nodeIds: { type: 'array', items: { type: 'string' }, description: 'Changed node ids (change, impact).' },
        reason: { type: 'string', description: 'Why the change is made (change).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', required: true },
            result: { type: 'object', required: true, additionalProperties: true },
          },
        },
        render: (_args, value) => traceRender(value),
      },
      execute(args, exec) {
        const project = ctx.iaTrace.project(traceScopeOf(exec))
        switch (args.action) {
          case 'record':
            if (args.kind === undefined || args.title === undefined) {
              throw new Error('ia_trace record needs `kind` and `title`')
            }
            return Promise.resolve({
              action: 'record',
              result: toResult(nodeOutput(project.addNode({
                kind: args.kind,
                title: args.title,
                ...(args.detail !== undefined ? { detail: args.detail } : {}),
                tags: args.tags ?? [],
                author: authorOf(exec),
                ...(args.basis !== undefined ? { basis: args.basis } : {}),
              }))),
            })
          case 'link':
            if (args.from === undefined || args.to === undefined || args.linkKind === undefined) {
              throw new Error('ia_trace link needs `from`, `to`, and `linkKind`')
            }
            project.addLink(TraceNodeId(args.from), TraceNodeId(args.to), args.linkKind)
            return Promise.resolve({ action: 'link', result: toResult({ from: args.from, to: args.to, kind: args.linkKind }) })
          case 'change':
            if (args.nodeIds === undefined || args.reason === undefined) {
              throw new Error('ia_trace change needs `nodeIds` and `reason`')
            }
            {
              const { record, impact } = project.recordChange({
                nodeIds: args.nodeIds.map(TraceNodeId),
                author: authorOf(exec),
                reason: args.reason,
              })
              return Promise.resolve({ action: 'change', result: toResult({ recordedAt: record.recordedAt, impact: impactOutput(impact) }) })
            }
          case 'impact':
            if (args.nodeIds === undefined) throw new Error('ia_trace impact needs `nodeIds`')
            return Promise.resolve({ action: 'impact', result: toResult(impactOutput(project.impactOf(args.nodeIds.map(TraceNodeId)))) })
          case 'matrix':
            return Promise.resolve({
              action: 'matrix',
              result: toResult({
                rows: project.matrix().map(row => ({
                  requirement: nodeOutput(row.requirement),
                  implementations: row.implementations.map(nodeOutput),
                  tests: row.tests.map(nodeOutput),
                  covered: row.covered,
                })),
              }),
            })
        }
      },
      presentCall: args => ({ card: 'generic', title: `Trace ${args.action}`, kind: 'other', rawInput: args }),
    }))
  }

  if (enabled.has('ia_gate')) {
    ctx.tools.register(defineTool({
      name: 'ia_gate',
      description:
        'List the project gates and ask one gate to release. Gate decisions belong to humans (or to registered auto-release rules at automation level A2/A3): you can only request, never decide. '
        + 'When a request stays pending, the approval channel is asked on your behalf; without an available answerer the request remains pending and you must tell the human supervisor. '
        + 'Dangerous gates (safety review, first power-on, acceptance signature, production-affecting changes) always require a human decision.',
      parameters: {
        action: { type: 'string', required: true, enum: ['list', 'request'], description: 'List gate status or request one gate.' },
        gateId: { type: 'string', description: 'The gate to request (request).' },
        reason: { type: 'string', description: 'Why the gate is requested now (request).' },
        evidence: { type: 'array', items: { type: 'string' }, description: 'Bounded evidence strings, e.g. verifier summaries (request).' },
        context: { type: 'string', description: 'Optional project context summary (request).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', required: true },
            result: { type: 'object', required: true, additionalProperties: true },
          },
        },
        render: (_args, value) => gateRender(value),
      },
      async execute(args, exec) {
        if (args.action === 'list') {
          const gates = ctx.iaGates.gatesList().map(gate => ({
            id: String(gate.id),
            title: gate.title,
            description: gate.description,
            alwaysHuman: gate.alwaysHuman,
            pendingRequests: ctx.iaGates.requestsFor(gate.id).filter(request => request.decision === undefined).length,
            latestDecision: ctx.iaGates.latestDecision(gate.id) ?? null,
          }))
          return { action: 'list', result: toResult({ gates }) }
        }
        if (args.gateId === undefined || args.reason === undefined) {
          throw new Error('ia_gate request needs `gateId` and `reason`')
        }
        const request = ctx.iaGates.request(GateId(args.gateId), authorOf(exec), {
          reason: args.reason,
          evidence: [...args.evidence ?? []],
          ...(args.context !== undefined ? { context: args.context } : {}),
        })
        if (request.decision !== undefined) {
          return {
            action: 'request',
            result: toResult({ gateId: args.gateId, decided: true, outcome: request.decision.outcome, decider: request.decision.decider }),
          }
        }
        if (exec.agent !== undefined) {
          const outcome = await ctx.iaGates.requestHumanDecision(GateId(args.gateId), exec.agent)
          const result: Record<string, JsonValue> = {
            gateId: args.gateId,
            decided: outcome !== 'pending',
            outcome,
          }
          if (outcome === 'pending') {
            result['note'] = 'no approval answerer is available: report this pending gate to the human supervisor'
          }
          return { action: 'request', result }
        }
        return {
          action: 'request',
          result: toResult({
            gateId: args.gateId,
            decided: false,
            outcome: 'pending',
            note: 'no owning agent session: report this pending gate to the human supervisor',
          }),
        }
      },
      presentCall: args => ({ card: 'generic', title: `Gate ${args.action}${args.gateId !== undefined ? ` ${args.gateId}` : ''}`, kind: 'other', rawInput: args }),
    }))
  }

  if (enabled.has('ia_knowledge')) {
    ctx.tools.register(defineTool({
      name: 'ia_knowledge',
      description:
        'Search and feed the industrial knowledge libraries (standards, templates, cases). Every hit carries its source and version citation — cite them when you reuse the content. '
        + 'Recording through this tool is the learning sink: entries enter `pending-review` and a human approves them later, so record only verified experience (e.g. failure-repair pairs after a passing re-verification). '
        + 'When the libraries are below their cold-start minimum scale, search results say `degraded: true` and you must state that no knowledge retrieval backed your work.',
      parameters: {
        action: { type: 'string', required: true, enum: ['search', 'record', 'readiness'], description: 'Search a library, record one entry, or read the cold-start readiness.' },
        library: { type: 'string', enum: [...LIBRARY_KINDS], description: 'The library: standards | templates | cases.' },
        query: { type: 'string', description: 'Whitespace-separated search terms (search).' },
        title: { type: 'string', description: 'Entry title (record).' },
        content: { type: 'string', description: 'Entry body (record).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Classification tags (record).' },
        source: { type: 'string', description: 'Citation source: project, clause, or document (record, mandatory).' },
        version: { type: 'string', description: 'Cited source version (record, mandatory).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', required: true },
            result: { type: 'object', required: true, additionalProperties: true },
          },
        },
        render: (_args, value) => knowledgeRender(value),
      },
      execute(args, exec) {
        switch (args.action) {
          case 'search':
            if (args.library === undefined || args.query === undefined) {
              throw new Error('ia_knowledge search needs `library` and `query`')
            }
            return Promise.resolve({ action: 'search', result: toResult(ctx.iaKnowledge.search(args.library, args.query)) })
          case 'record':
            if (args.library === undefined || args.title === undefined || args.content === undefined
              || args.source === undefined || args.version === undefined) {
              throw new Error('ia_knowledge record needs `library`, `title`, `content`, `source`, and `version`')
            }
            {
              const entry = ctx.iaKnowledge.record({
                library: args.library,
                title: args.title,
                content: args.content,
                tags: args.tags ?? [],
                source: args.source,
                version: args.version,
                recordedBy: authorOf(exec),
                reviewStatus: 'pending-review',
              })
              return Promise.resolve({ action: 'record', result: toResult({ id: String(entry.id), reviewStatus: entry.reviewStatus }) })
            }
          case 'readiness':
            return Promise.resolve({ action: 'readiness', result: toResult(ctx.iaKnowledge.readiness()) })
        }
      },
      presentCall: args => ({ card: 'generic', title: `Knowledge ${args.action}`, kind: 'other', rawInput: args }),
    }))
  }

  if (enabled.has('ia_project')) {
    ctx.tools.register(defineTool({
      name: 'ia_project',
      description:
        'Drive the orchestrator DAG of the current industrial project: instantiate the stage chain from a template, advance stages, and submit artifacts. '
        + 'Submissions run the stage\'s deterministic verifiers first; failures return the stage to repair with the reports, and exhausting the retry budget escalates to the human supervisor with a package you must not resolve yourself. '
        + 'Stages with a bound gate stop at `gated` until a human (or a configured rule) decides; poll status to see the decision.',
      parameters: {
        action: { type: 'string', required: true, enum: ['init', 'list', 'status', 'advance', 'submit', 'export'], description: 'The project operation.' },
        projectId: { type: 'string', description: 'Target project id; defaults to the project this agent initialized.' },
        template: { type: 'string', description: 'Template name for init; the default is conveyor-line.' },
        stageId: { type: 'string', description: 'Stage id for advance/submit.' },
        text: { type: 'string', description: 'Artifact text for submit.' },
        vendorSource: { type: 'string', description: 'Optional vendor-dialect source for external compile verifiers such as tia-compile (submit).' },
        reference: { type: 'string', description: 'Optional artifact reference, e.g. a trace node id (submit).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', required: true },
            result: { type: 'object', required: true, additionalProperties: true },
          },
        },
        render: (_args, value) => projectRender(value),
      },
      async execute(args, exec) {
        switch (args.action) {
          case 'init': {
            const snapshot = ctx.iaOrchestrator.initProject(undefined, args.template)
            if (exec.agent !== undefined) currentProject.set(exec.agent, snapshot.id)
            return Promise.resolve({ action: 'init', result: toResult(snapshotOutput(snapshot)) })
          }
          case 'list':
            return Promise.resolve({ action: 'list', result: toResult({ projects: ctx.iaOrchestrator.projectsList().map(snapshotOutput) }) })
          case 'status': {
            const snapshot = ctx.iaOrchestrator.project(projectOf(exec, args.projectId))
            return Promise.resolve({ action: 'status', result: toResult(snapshotOutput(snapshot)) })
          }
          case 'advance': {
            if (args.stageId === undefined) throw new Error('ia_project advance needs `stageId`')
            const snapshot = ctx.iaOrchestrator.advance(projectOf(exec, args.projectId), StageId(args.stageId))
            return Promise.resolve({ action: 'advance', result: toResult(snapshotOutput(snapshot)) })
          }
          case 'submit': {
            if (args.stageId === undefined || args.text === undefined) {
              throw new Error('ia_project submit needs `stageId` and `text`')
            }
            const projectId = projectOf(exec, args.projectId)
            const stage = await ctx.iaOrchestrator.submit(projectId, StageId(args.stageId), {
              text: args.text,
              ...(args.vendorSource !== undefined ? { vendorSource: args.vendorSource } : {}),
              ...(args.reference !== undefined ? { reference: args.reference } : {}),
              submittedBy: authorOf(exec),
            })
            return { action: 'submit', result: toResult(stageOutput(stage)) }
          }
          case 'export': {
            const audit = ctx.iaOrchestrator.exportAudit(projectOf(exec, args.projectId))
            return Promise.resolve({ action: 'export', result: toResult(audit) })
          }
        }
      },
      presentCall: args => ({ card: 'generic', title: `Project ${args.action}`, kind: 'other', rawInput: args }),
    }))
  }
}

/** JSON-serializable digest of one project snapshot for tool output. */
function snapshotOutput(snapshot: {
  id: unknown
  template: string
  stages: StageSnapshot[]
  requestedGates: unknown[]
  instructions: { stageId: unknown; instruction: string }[]
}) {
  return {
    id: String(snapshot.id),
    template: snapshot.template,
    stages: snapshot.stages.map(stageOutput),
    requestedGates: snapshot.requestedGates.map(String),
    instructions: snapshot.instructions.map(item => ({ stageId: String(item.stageId), instruction: item.instruction })),
  }
}

/** JSON-serializable digest of one stage snapshot for tool output. */
function stageOutput(stage: {
  id: unknown
  title: string
  state: string
  attempts: number
  maxRetries: number
  verifiers: string[]
  gate?: string
  gateStatus?: string
  reports?: unknown[]
  escalation?: unknown
  instruction?: string
}) {
  return {
    id: String(stage.id),
    title: stage.title,
    state: stage.state,
    attempts: stage.attempts,
    maxRetries: stage.maxRetries,
    verifiers: stage.verifiers,
    ...(stage.gate !== undefined ? { gate: stage.gate } : {}),
    ...(stage.gateStatus !== undefined ? { gateStatus: stage.gateStatus } : {}),
    ...(stage.reports !== undefined ? { reports: stage.reports } : {}),
    ...(stage.escalation !== undefined ? { escalation: stage.escalation } : {}),
    ...(stage.instruction !== undefined ? { instruction: stage.instruction } : {}),
  }
}
