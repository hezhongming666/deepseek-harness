/**
 * The `st-lint` deterministic validator: name-resolution and hygiene rules
 * over a parsed Structured Text program. Rules mirror the design's lint
 * evidence category — undefined references, duplicate declarations, unused
 * variables, and loop control outside loops — and never depend on a model.
 * @module @deepseek-ai/dsh-ia-verifier
 */

import type { Diagnostic, VerificationInput, VerificationReport } from '../types.ts'
import type { Expression, Program, Statement, StType, VarDecl } from './ast.ts'
import { parse } from './parser.ts'
import { buildReport, ST_SYNTAX_KIND } from './syntax.ts'

/** Stable registry kind of this validator. */
export const ST_LINT_KIND = 'st-lint' as const

/** Callable standard function names that need no declaration. */
const BUILTINS = new Set(['TON', 'TOF', 'TP', 'CTU', 'CTD', 'CTUD', 'ABS', 'SQRT', 'MIN', 'MAX', 'LIMIT', 'SEL', 'MUX'])

/** Whether one type is a named (function-block or user-type) reference. */
function namedType(type: StType): string | undefined {
  return type.kind === 'named' ? type.name : undefined
}

/**
 * Run the Structured Text lint check. The input must parse; syntax problems
 * are re-reported from the syntax check so one tool call sees both.
 * @param input - the checked source text.
 * @returns the report; undefined references, duplicate declarations, and
 *   out-of-loop control are errors; unused variables are warnings.
 */
export function verifyStLint(input: VerificationInput): VerificationReport {
  const { program, diagnostics } = parse(input.text)
  const syntaxErrors = diagnostics.length
  if (program === undefined) {
    return buildReport(ST_LINT_KIND, diagnostics, {
      kind: 'lint',
      summary: 'lint skipped: the program did not parse',
      detail: `${syntaxErrors} syntax problem(s) block lint analysis`,
    })
  }
  diagnostics.push(...lint(program))
  const errors = diagnostics.filter(d => d.severity === 'error').length
  return buildReport(ST_LINT_KIND, diagnostics, {
    kind: 'lint',
    summary: diagnostics.length === 0 ? 'no lint findings' : `${errors} error(s), ${diagnostics.length - errors} warning(s)`,
    detail: `checked ${program.declarations.length} program declaration(s), ${program.functionBlocks.length} function block(s)`,
  })
}

/** The syntactic kind a lint run re-reports through. */
export { ST_SYNTAX_KIND }

/** A name-resolution environment: a scope chain plus the loop depth. */
interface Env {
  /** Declared names, innermost scope first, outermost last. */
  scopes: Set<string>[]
  /** Current loop nesting depth. */
  inLoop: number
}

/**
 * Lint one parsed program.
 * @param program - the parsed program.
 * @returns findings in source order; every error carries a position.
 */
export function lint(program: Program): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const fbNames = new Set<string>()
  for (const block of program.functionBlocks) {
    if (fbNames.has(block.name)) {
      diagnostics.push({
        code: 'st-lint-duplicate-fb',
        message: `duplicate function block ${block.name}`,
        severity: 'error',
        position: block.position,
      })
    }
    fbNames.add(block.name)
  }

  const programScope = collectDeclarations(program.declarations, fbNames, diagnostics)
  const programEnv: Env = { scopes: [programScope], inLoop: 0 }
  const programRefs = new Set<string>()
  for (const statement of program.statements) checkStatement(statement, programEnv, programRefs, diagnostics)
  reportUnused(program.declarations, programRefs, diagnostics)

  for (const block of program.functionBlocks) {
    const fbScope = collectDeclarations(block.declarations, fbNames, diagnostics)
    const fbEnv: Env = { scopes: [fbScope, programScope], inLoop: 0 }
    const fbRefs = new Set<string>()
    for (const statement of block.statements) checkStatement(statement, fbEnv, fbRefs, diagnostics)
    reportUnused(block.declarations, fbRefs, diagnostics)
  }
  return diagnostics
}

/**
 * Build one scope's declared-name set, flagging duplicate declarations and
 * unknown named types.
 * @param declarations - the declarations of one scope.
 * @param fbNames - declared function-block names, for named-type resolution.
 * @param diagnostics - the shared diagnostic sink.
 * @returns the scope's declared names.
 */
function collectDeclarations(
  declarations: readonly VarDecl[],
  fbNames: ReadonlySet<string>,
  diagnostics: Diagnostic[],
): Set<string> {
  const names = new Set<string>()
  for (const decl of declarations) {
    for (const name of decl.names) {
      if (names.has(name)) {
        diagnostics.push({
          code: 'st-lint-duplicate-var',
          message: `duplicate declaration of ${name}`,
          severity: 'error',
          position: decl.position,
        })
      }
      names.add(name)
    }
    const named = namedType(decl.type)
    if (named !== undefined && !fbNames.has(named)) {
      diagnostics.push({
        code: 'st-lint-unknown-type',
        message: `unknown type ${named}`,
        severity: 'error',
        position: decl.position,
      })
    }
  }
  return names
}

/** Check one statement, collecting references and control-flow findings. */
function checkStatement(
  statement: Statement,
  env: Env,
  refs: Set<string>,
  diagnostics: Diagnostic[],
): void {
  switch (statement.kind) {
    case 'assignment':
      checkExpression(statement.target, env, refs, diagnostics)
      checkExpression(statement.value, env, refs, diagnostics)
      return
    case 'call':
      resolve(statement.name, env, refs, diagnostics, statement.position)
      for (const arg of statement.args) checkExpression(arg, env, refs, diagnostics)
      return
    case 'if':
      for (const arm of statement.arms) {
        checkExpression(arm.condition, env, refs, diagnostics)
        for (const child of arm.statements) checkStatement(child, env, refs, diagnostics)
      }
      if (statement.elseArm !== undefined) {
        for (const child of statement.elseArm) checkStatement(child, env, refs, diagnostics)
      }
      return
    case 'case':
      checkExpression(statement.selector, env, refs, diagnostics)
      for (const arm of statement.arms) {
        for (const label of arm.labels) checkExpression(label, env, refs, diagnostics)
        for (const child of arm.statements) checkStatement(child, env, refs, diagnostics)
      }
      if (statement.elseArm !== undefined) {
        for (const child of statement.elseArm) checkStatement(child, env, refs, diagnostics)
      }
      return
    case 'for':
      resolve(statement.variable, env, refs, diagnostics, statement.position)
      checkExpression(statement.from, env, refs, diagnostics)
      checkExpression(statement.to, env, refs, diagnostics)
      if (statement.by !== undefined) checkExpression(statement.by, env, refs, diagnostics)
      env.inLoop += 1
      for (const child of statement.statements) checkStatement(child, env, refs, diagnostics)
      env.inLoop -= 1
      return
    case 'while':
      checkExpression(statement.condition, env, refs, diagnostics)
      env.inLoop += 1
      for (const child of statement.statements) checkStatement(child, env, refs, diagnostics)
      env.inLoop -= 1
      return
    case 'repeat':
      env.inLoop += 1
      for (const child of statement.statements) checkStatement(child, env, refs, diagnostics)
      env.inLoop -= 1
      checkExpression(statement.condition, env, refs, diagnostics)
      return
    case 'exit':
    case 'continue':
      if (env.inLoop === 0) {
        diagnostics.push({
          code: 'st-lint-loop-control-outside-loop',
          message: `${statement.kind.toUpperCase()} outside a loop`,
          severity: 'error',
          position: statement.position,
        })
      }
      return
    case 'return':
      return
  }
}

/**
 * Check one expression, resolving every referenced name.
 * @param expression - the expression to walk.
 * @param env - the name-resolution environment.
 * @param refs - the scope's reference set, for unused-variable warnings.
 * @param diagnostics - the shared diagnostic sink.
 */
function checkExpression(
  expression: Expression,
  env: Env,
  refs: Set<string>,
  diagnostics: Diagnostic[],
): void {
  switch (expression.kind) {
    case 'literal':
      return
    case 'reference':
      resolve(expression.name, env, refs, diagnostics, expression.position)
      return
    case 'call':
      resolve(expression.name, env, refs, diagnostics, expression.position)
      for (const arg of expression.args) checkExpression(arg, env, refs, diagnostics)
      return
    case 'unary':
      checkExpression(expression.operand, env, refs, diagnostics)
      return
    case 'binary':
      checkExpression(expression.left, env, refs, diagnostics)
      checkExpression(expression.right, env, refs, diagnostics)
      return
    case 'index':
      checkExpression(expression.base, env, refs, diagnostics)
      checkExpression(expression.index, env, refs, diagnostics)
      return
  }
}

/**
 * Resolve one name against the scope chain, recording a reference or an
 * undefined-name error.
 * @param name - the upper-cased referenced name.
 * @param env - the name-resolution environment.
 * @param refs - the owning scope's reference set.
 * @param diagnostics - the shared diagnostic sink.
 * @param position - the reference's source position.
 */
function resolve(
  name: string,
  env: Env,
  refs: Set<string>,
  diagnostics: Diagnostic[],
  position: { line: number; column: number },
): void {
  if (BUILTINS.has(name)) {
    refs.add(name)
    return
  }
  if (env.scopes.some(scope => scope.has(name))) {
    refs.add(name)
    return
  }
  diagnostics.push({
    code: 'st-lint-undefined',
    message: `undefined variable or function ${name}`,
    severity: 'error',
    position,
  })
}

/** Warn about declared names that no statement ever referenced. */
function reportUnused(declarations: readonly VarDecl[], refs: ReadonlySet<string>, diagnostics: Diagnostic[]): void {
  for (const decl of declarations) {
    for (const name of decl.names) {
      if (!refs.has(name)) {
        diagnostics.push({
          code: 'st-lint-unused',
          message: `variable ${name} is declared but never used`,
          severity: 'warning',
          position: decl.position,
        })
      }
    }
  }
}
