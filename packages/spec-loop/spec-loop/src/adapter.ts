/**
 * Service Definition for the spec-loop adapter seam. A deployment registers
 * one provider that implements the software's validation and run surface; the
 * tool consumer resolves it through `ctx.get('specLoopAdapter')` and fails
 * loud when none is mounted.
 * @module @deepseek-ai/dsh-spec-loop
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  AdapterRunOutcome,
  AdapterRunRequest,
  SpecLoopParams,
  ValidationOutcome,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    specLoopAdapter: SpecLoopAdapterService
  }
}

/**
 * The adapter contract one industrial-software integration implements. Both
 * methods are per-call operations; implementations keep no job state between
 * calls and honor the request signal in `run` (H-3).
 */
export abstract class SpecLoopAdapterService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'specLoopAdapter')
  }

  /**
   * Cheap feasibility pre-check (S-7 dry-run): reject infeasible parameters
   * without consuming license or resources.
   * @param params - the candidate parameter set.
   * @returns the S1 gate outcome.
   */
  abstract validate(params: SpecLoopParams): Promise<ValidationOutcome>

  /**
   * Execute one candidate through the software and return the structured
   * outcome (S-5). Solver divergence and infrastructure failures are outcome
   * statuses, never thrown exceptions.
   * @param request - the candidate plus the cancellation signal.
   * @returns the run outcome.
   */
  abstract run(request: AdapterRunRequest): Promise<AdapterRunOutcome>
}

export default SpecLoopAdapterService
