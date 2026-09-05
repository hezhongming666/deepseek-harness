/**
 * Project orchestrator — the design's DAG scheduler with verify-then-gate
 * transitions. A project instantiates a template chain; every submission runs
 * the stage's deterministic verifiers first, then requests the bound gate.
 * Failing submissions retry within the inner-loop budget (§4.1, default 3)
 * and escalate to a human with a packaged context (§4.2). The orchestrator
 * reads gate decisions, never makes them.
 * @module @deepseek-ai/dsh-ia-orchestrator
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { GateId } from '@deepseek-ai/dsh-ia-gates'
import type { VerificationReport } from '@deepseek-ai/dsh-ia-verifier'
import { ProjectId, StageId, StageTransitionError, UnknownStageError } from './types.ts'
import type {
  DagTemplate,
  EscalationPackage,
  ProjectSnapshot,
  StageSnapshot,
  StageState,
  StageTemplate,
  Submission,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    iaOrchestrator: IaOrchestratorService
  }
}

/**
 * The built-in `conveyor-line` template: the engineering loop stages of the
 * architecture §2.1, from requirements through acceptance.
 */
const CONVEYOR_LINE: DagTemplate = {
  name: 'conveyor-line',
  stages: [
    {
      id: StageId('requirements'),
      title: 'Requirements engineering',
      verifiers: [],
      gate: GateId('requirement-baseline'),
      maxRetries: 3,
      description: 'Structure the customer input into the requirement matrix and clarification questions.',
    },
    {
      id: StageId('design'),
      title: 'Solution design',
      verifiers: [],
      gate: GateId('design-review'),
      maxRetries: 3,
      description: 'Draft the control scheme, selection, IO estimate, and safety pre-assessment.',
    },
    {
      id: StageId('control-program'),
      title: 'Control program',
      verifiers: ['st-syntax', 'st-lint'],
      optionalVerifiers: ['tia-compile'],
      maxRetries: 3,
      description: 'Generate the IEC 61131-3 Structured Text program; it must pass the syntax and lint checks, plus the real vendor compile when a TIA adapter is mounted.',
    },
    {
      id: StageId('simulation'),
      title: 'Simulation verification',
      verifiers: [],
      gate: GateId('release-review'),
      maxRetries: 3,
      description: 'Present the virtual-commissioning evidence for the release review.',
    },
    {
      id: StageId('commissioning'),
      title: 'Commissioning',
      verifiers: [],
      gate: GateId('first-power-on'),
      maxRetries: 3,
      description: 'Prepare the download and point-check scripts for the first power-on.',
    },
    {
      id: StageId('acceptance'),
      title: 'Acceptance',
      verifiers: [],
      gate: GateId('acceptance-signoff'),
      maxRetries: 3,
      description: 'Assemble the documentation package for the acceptance signature.',
    },
  ],
}

/** The project gate the orchestrator registers for release reviews. */
const RELEASE_REVIEW = {
  id: GateId('release-review'),
  title: 'Release review',
  description: 'A human confirms the simulation evidence and releases the engineering package.',
  alwaysHuman: false,
}

/**
 * Orchestrator configuration.
 */
export interface Config {
  /** The template instantiated by {@link IaOrchestratorService.initProject} (default `conveyor-line`). */
  template?: string
}

/** Schemastery configuration for the orchestrator. */
export const Config: Schema<Config> = z.object({
  template: z.string().default('conveyor-line'),
})

/** Internal per-stage record backing the snapshots. */
interface StageRecord {
  /** The template node. */
  template: StageTemplate
  /** Current lifecycle state. */
  state: StageState
  /** Failing submissions in the current run. */
  attempts: number
  /** Latest verification reports. */
  reports?: VerificationReport[]
  /** Escalation package, present while escalated. */
  escalation?: EscalationPackage
  /** Human rework instruction, present after an escalation resolution. */
  instruction?: string
}

/** Internal project record: template plus per-stage records. */
interface ProjectRecord {
  /** Opaque project id. */
  id: ProjectId
  /** Template name. */
  template: string
  /** Stage records in dependency order. */
  stages: StageRecord[]
  /** Gate ids requested through the orchestrator. */
  requestedGates: GateId[]
  /** Escalation-resolution instructions, latest first. */
  instructions: { stageId: StageId; instruction: string }[]
}

/**
 * The project orchestrator. Projects are isolated by id; the service owns no
 * approval authority — gate decisions are read back from the gate engine.
 */
export class IaOrchestratorService extends Service {
  static Config: Schema<Config> = Config
  /** The verifier and gate registries the DAG stages bind to. */
  static inject = ['iaVerifiers', 'iaGates']

  private readonly defaultTemplate: string
  private readonly verifiers: Context['iaVerifiers']
  private readonly gates: Context['iaGates']
  private readonly templates = new Map<string, DagTemplate>()
  private readonly projects = new Map<ProjectId, ProjectRecord>()
  private ordinal = 0
  private readonly listeners = new Set<() => void>()

  /**
   * Create the orchestrator, validate the template against the composed
   * verifier and gate registries, and register the release-review gate.
   * @param ctx - Cordis context carrying the verifier and gate services.
   * @param config - the default instantiation template.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'iaOrchestrator')
    this.verifiers = ctx.iaVerifiers
    this.gates = ctx.iaGates
    this.templates.set(CONVEYOR_LINE.name, CONVEYOR_LINE)
    const templateName = config.template ?? 'conveyor-line'
    const template = this.templates.get(templateName)
    if (template === undefined) {
      throw new Error(`iaOrchestrator: unknown template ${JSON.stringify(templateName)}; available: ${[...this.templates.keys()].join(', ')}`)
    }
    this.defaultTemplate = templateName
    const kinds = new Set(this.verifiers.kinds())
    for (const stage of template.stages) {
      for (const kind of stage.verifiers) {
        if (!kinds.has(kind)) {
          throw new Error(`iaOrchestrator: template stage ${JSON.stringify(String(stage.id))} binds unknown verifier ${JSON.stringify(kind)}`)
        }
      }
    }
    this.gates.registerGate(RELEASE_REVIEW)
  }

  /** List the registered template names.
   * @returns the registered template names. */
  templatesList(): string[] {
    return [...this.templates.keys()]
  }

  /**
   * Instantiate one project from a template. Every stage starts `pending`
   * except the first, which starts `running`.
   * @param projectId - explicit project id, or a service-issued one.
   * @param templateName - the template to instantiate (default: configured).
   * @returns the project snapshot.
   */
  initProject(projectId?: ProjectId, templateName: string = this.defaultTemplate): ProjectSnapshot {
    const template = this.templates.get(templateName)
    if (template === undefined) {
      throw new Error(`iaOrchestrator: unknown template ${JSON.stringify(templateName)}`)
    }
    const id = projectId ?? ProjectId(`project-${this.ordinal + 1}`)
    this.ordinal += 1
    const record: ProjectRecord = {
      id,
      template: templateName,
      stages: template.stages.map((node, index) => ({
        template: node,
        state: index === 0 ? 'running' : 'pending',
        attempts: 0,
      })),
      requestedGates: [],
      instructions: [],
    }
    this.projects.set(id, record)
    this.notify()
    return this.snapshot(record)
  }

  /**
   * Read one project snapshot, syncing bound gate decisions first: an
   * approved gate passes a `gated` stage, a rejected gate sends it back to
   * `running` for rework.
   * @param projectId - the project to read.
   * @returns the current snapshot.
   */
  project(projectId: ProjectId): ProjectSnapshot {
    const record = this.requireProject(projectId)
    this.syncGates(record)
    return this.snapshot(record)
  }

  /** List every instantiated project.
   * @returns all instantiated projects, snapshotted with synced gate decisions. */
  projectsList(): ProjectSnapshot[] {
    return [...this.projects.values()].map((record) => {
      this.syncGates(record)
      return this.snapshot(record)
    })
  }

  /**
   * Start a `pending` stage; every predecessor stage must have passed.
   * @param projectId - the owning project.
   * @param stageId - the stage to start.
   * @returns the updated project snapshot.
   */
  advance(projectId: ProjectId, stageId: StageId): ProjectSnapshot {
    const record = this.requireProject(projectId)
    const index = record.stages.findIndex(stage => stage.template.id === stageId)
    if (index < 0) throw new UnknownStageError(projectId, stageId)
    const stage = record.stages[index]
    if (stage === undefined) throw new UnknownStageError(projectId, stageId)
    if (stage.state !== 'pending') throw new StageTransitionError(stageId, stage.state, 'advance')
    for (const predecessor of record.stages.slice(0, index)) {
      if (predecessor.state !== 'passed') {
        throw new StageTransitionError(stageId, 'pending', `advance before ${String(predecessor.template.id)} passed`)
      }
    }
    stage.state = 'running'
    this.notify()
    return this.snapshot(record)
  }

  /**
   * Submit one artifact into a `running` or `repair` stage: run the bound
   * verifiers, then request the bound gate on success, retry on failure
   * within the budget, and escalate when the budget is exhausted.
   * @param projectId - the owning project.
   * @param stageId - the receiving stage.
   * @param submission - the artifact text, optional vendor-dialect source, and submitter identity.
   * @returns the updated stage snapshot.
   */
  async submit(projectId: ProjectId, stageId: StageId, submission: Submission): Promise<StageSnapshot> {
    const record = this.requireProject(projectId)
    const stage = record.stages.find(candidate => candidate.template.id === stageId)
    if (stage === undefined) throw new UnknownStageError(projectId, stageId)
    if (stage.state !== 'running' && stage.state !== 'repair') {
      throw new StageTransitionError(stageId, stage.state, 'submit to')
    }
    if (submission.text.length === 0) {
      throw new Error('iaOrchestrator: submission `text` must be non-empty')
    }
    if (submission.submittedBy.trim().length === 0) {
      throw new Error('iaOrchestrator: submission `submittedBy` must be non-empty')
    }
    const reports = await this.verifiers.verifyAll(this.effectiveVerifiers(stage), {
      text: submission.text,
      ...(submission.vendorSource === undefined ? {} : { vendorSource: submission.vendorSource }),
    })
    stage.reports = reports
    const passed = reports.every(report => report.pass)
    if (!passed) {
      stage.attempts += 1
      if (stage.attempts >= stage.template.maxRetries) {
        stage.state = 'escalated'
        stage.escalation = buildEscalation(stage, submission, reports)
        this.notify()
        return this.stageSnapshot(stage)
      }
      stage.state = 'repair'
      this.notify()
      return this.stageSnapshot(stage)
    }
    if (stage.template.gate !== undefined) {
      stage.state = 'gated'
      const gate = stage.template.gate
      this.gates.request(gate, submission.submittedBy.trim(), {
        reason: `stage ${String(stageId)} verified: ${reports.map(report => `${report.kind}: ${report.pass ? 'pass' : 'fail'}`).join(', ')}`,
        evidence: reports.map(report => report.evidence.map(item => `${item.kind}: ${item.summary}`).join('; ')).filter(text => text.length > 0),
        context: `${stage.template.description} (artifact ${submission.reference ?? 'unreferenced'})`,
      })
      record.requestedGates.push(gate)
    } else {
      stage.state = 'passed'
    }
    this.notify()
    return this.stageSnapshot(stage)
  }

  /**
   * Resolve one escalated stage with a human instruction: the stage returns
   * to `running` with a fresh inner-loop budget and the instruction attached
   * for the agent to read. This is a supervisor path — no model-facing tool
   * exposes it.
   * @param projectId - the owning project.
   * @param stageId - the escalated stage.
   * @param instruction - what the supervisor asks the agent to do.
   * @returns the updated stage snapshot.
   */
  resolveEscalation(projectId: ProjectId, stageId: StageId, instruction: string): StageSnapshot {
    const record = this.requireProject(projectId)
    const stage = record.stages.find(candidate => candidate.template.id === stageId)
    if (stage === undefined) throw new UnknownStageError(projectId, stageId)
    if (stage.state !== 'escalated') throw new StageTransitionError(stageId, stage.state, 'resolve escalation of')
    if (instruction.trim().length === 0) throw new Error('iaOrchestrator: escalation instruction must be non-empty')
    stage.state = 'running'
    stage.attempts = 0
    stage.instruction = instruction.trim()
    delete stage.escalation
    record.instructions.unshift({ stageId, instruction: instruction.trim() })
    this.notify()
    return this.stageSnapshot(stage)
  }

  /** Subscribe to post-mutation notifications; the registration lives as long as the service.
   * @param listener - called after every committed mutation. */
  onMutate(listener: () => void): void {
    this.listeners.add(listener)
  }

  /** Resolve one project record or throw. */
  private requireProject(projectId: ProjectId): ProjectRecord {
    const record = this.projects.get(projectId)
    if (record === undefined) throw new UnknownStageError(projectId)
    return record
  }

  /** Pull the latest gate decisions into gated stages. */
  private syncGates(record: ProjectRecord): void {
    for (const stage of record.stages) {
      if (stage.state !== 'gated' || stage.template.gate === undefined) continue
      const decision = this.gates.latestDecision(stage.template.gate)
      if (decision === undefined) continue
      if (decision.outcome === 'approved') stage.state = 'passed'
      else stage.state = 'running'
    }
  }

  /**
   * The verifier kinds a stage actually runs: its required kinds plus any
   * optional kind that is registered. Optional kinds exist for adapters a
   * deployment may or may not mount (`tia-compile`); skipping an unregistered
   * optional kind is the declared behavior, not a misconfiguration.
   * @param stage - the stage record.
   * @returns the effective kind list, required kinds first.
   */
  private effectiveVerifiers(stage: StageRecord): string[] {
    const registered = new Set(this.verifiers.kinds())
    return [
      ...stage.template.verifiers,
      ...(stage.template.optionalVerifiers ?? []).filter(kind => registered.has(kind)),
    ]
  }

  /** Project one stage record into its snapshot. */
  private stageSnapshot(stage: StageRecord): StageSnapshot {
    const gateStatus = this.gateStatus(stage)
    return {
      id: stage.template.id,
      title: stage.template.title,
      state: stage.state,
      attempts: stage.attempts,
      maxRetries: stage.template.maxRetries,
      verifiers: this.effectiveVerifiers(stage),
      ...(stage.template.gate !== undefined ? { gate: stage.template.gate } : {}),
      ...(stage.reports !== undefined ? { reports: stage.reports } : {}),
      ...(stage.escalation !== undefined ? { escalation: stage.escalation } : {}),
      ...(stage.instruction !== undefined ? { instruction: stage.instruction } : {}),
      ...(gateStatus !== 'none' ? { gateStatus } : {}),
    }
  }

  /** The bound gate's latest decision, folded into the stage state. */
  private gateStatus(stage: StageRecord): 'none' | 'pending' | 'approved' | 'rejected' {
    if (stage.template.gate === undefined) return 'none'
    const decision = this.gates.latestDecision(stage.template.gate)
    if (decision === undefined) return 'pending'
    return decision.outcome
  }

  /** Project one project record into its snapshot. */
  private snapshot(record: ProjectRecord): ProjectSnapshot {
    return {
      id: record.id,
      template: record.template,
      stages: record.stages.map(stage => this.stageSnapshot(stage)),
      requestedGates: [...record.requestedGates],
      instructions: record.instructions.map(item => ({ stageId: item.stageId, instruction: item.instruction })),
    }
  }

  /** Publish a mutation to listeners after it has committed. */
  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

/** Build the escalation package from the exhausted stage and its evidence. */
function buildEscalation(stage: StageRecord, submission: Submission, reports: readonly VerificationReport[]): EscalationPackage {
  const failures = reports.filter(report => !report.pass)
  return {
    stageId: stage.template.id,
    reason: `inner loop exhausted after ${stage.attempts} failing submission(s)`,
    context: stage.template.description,
    artifact: submission.text,
    reports: [...reports],
    failureSummary: failures.length === 0
      ? 'verification reported no failing check but did not pass'
      : failures.map(report => `${report.kind}: ${report.diagnostics.filter(d => d.severity === 'error').length} error(s)`).join('; '),
    options: [
      'instruct the agent to rework the artifact with a concrete correction',
      'revisit the requirement baseline and re-run the affected stages',
      'reject the stage and close the project',
    ],
  }
}

export default IaOrchestratorService
export * from './types.ts'
