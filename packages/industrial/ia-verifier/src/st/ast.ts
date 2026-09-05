/**
 * Abstract syntax tree of the supported IEC 61131-3 Structured Text subset.
 * Nodes carry their `position` so lint findings anchor to source, and a closed
 * `kind` tag so consumers switch exhaustively.
 * @module @deepseek-ai/dsh-ia-verifier
 */

import type { SourcePosition } from '../types.ts'

/** One-based source position, copied from the shared diagnostic vocabulary. */
export type { SourcePosition }

/** Data type reference in a variable declaration. */
export type StType = ElementaryType | ArrayType | NamedType

/** Built-in elementary type name such as `INT`, `BOOL`, or `REAL`. */
export interface ElementaryType {
  /** Closed tag. */
  kind: 'elementary'
  /** Upper-cased type name. */
  name: string
}

/** Array type with one index range, e.g. `ARRAY[0..7] OF BOOL`. */
export interface ArrayType {
  /** Closed tag. */
  kind: 'array'
  /** Lower index bound. */
  lower: number
  /** Upper index bound. */
  upper: number
  /** Element type. */
  element: StType
}

/** Reference to a function-block or user-defined type by name. */
export interface NamedType {
  /** Closed tag. */
  kind: 'named'
  /** Upper-cased type name. */
  name: string
}

/** One variable declaration: a name list sharing one type, init, and address. */
export interface VarDecl {
  /** Declared names, upper-cased, in source order. */
  names: string[]
  /** Declared type. */
  type: StType
  /** Initializer expression, when the declaration has `:=` init. */
  init?: Expression
  /** Hardware address after `AT`, e.g. `%Q0.0`, when declared. */
  address?: string
  /** Position of the declaration's first name. */
  position: SourcePosition
}

/** A function-block definition: local declarations plus statements. */
export interface FunctionBlock {
  /** Closed tag. */
  kind: 'function-block'
  /** Upper-cased function-block name. */
  name: string
  /** Local `VAR` declarations, in source order. */
  declarations: VarDecl[]
  /** Body statements, in source order. */
  statements: Statement[]
  /** Position of the `FUNCTION_BLOCK` keyword. */
  position: SourcePosition
}

/** A complete program: declarations, function blocks, and body statements. */
export interface Program {
  /** Closed tag. */
  kind: 'program'
  /** Upper-cased program name. */
  name: string
  /** Program-level `VAR` declarations, in source order. */
  declarations: VarDecl[]
  /** Function-block definitions, in source order. */
  functionBlocks: FunctionBlock[]
  /** Body statements, in source order. */
  statements: Statement[]
  /** Position of the `PROGRAM` keyword. */
  position: SourcePosition
}

/** Every statement of the supported subset. */
export type Statement =
  | AssignmentStatement
  | CallStatement
  | IfStatement
  | CaseStatement
  | ForStatement
  | WhileStatement
  | RepeatStatement
  | ExitStatement
  | ContinueStatement
  | ReturnStatement

/** `target := value`. */
export interface AssignmentStatement {
  /** Closed tag. */
  kind: 'assignment'
  /** Assignment target expression. */
  target: Expression
  /** Assigned value expression. */
  value: Expression
  /** Position of the `:=` operator. */
  position: SourcePosition
}

/** Bare function or function-block call `name(args)`. */
export interface CallStatement {
  /** Closed tag. */
  kind: 'call'
  /** Upper-cased called name. */
  name: string
  /** Call arguments, in source order. */
  args: Expression[]
  /** Position of the called name. */
  position: SourcePosition
}

/** One condition-and-body arm of an IF/ELSIF chain. */
export interface IfArm {
  /** Arm condition expression. */
  condition: Expression
  /** Arm body statements. */
  statements: Statement[]
}

/** `IF ... THEN ... ELSIF ... ELSE ... END_IF`. */
export interface IfStatement {
  /** Closed tag. */
  kind: 'if'
  /** Arms in source order; the first is the `IF` arm, later ones are `ELSIF`. */
  arms: IfArm[]
  /** `ELSE` body, present when the source has an `ELSE` arm. */
  elseArm?: Statement[]
  /** Position of the `IF` keyword. */
  position: SourcePosition
}

/** One labeled body of a CASE arm. */
export interface CaseArm {
  /** Case labels: number literals or identifier constants. */
  labels: Expression[]
  /** Arm body statements. */
  statements: Statement[]
}

/** `CASE selector OF ... END_CASE`. */
export interface CaseStatement {
  /** Closed tag. */
  kind: 'case'
  /** Selector expression. */
  selector: Expression
  /** Labeled arms in source order. */
  arms: CaseArm[]
  /** `ELSE` body, present when the source has an `ELSE` arm. */
  elseArm?: Statement[]
  /** Position of the `CASE` keyword. */
  position: SourcePosition
}

/** `FOR variable := from TO to ... END_FOR`. */
export interface ForStatement {
  /** Closed tag. */
  kind: 'for'
  /** Upper-cased loop variable name. */
  variable: string
  /** Lower bound expression. */
  from: Expression
  /** Upper bound expression. */
  to: Expression
  /** Step expression after `BY`, when present. */
  by?: Expression
  /** Loop body statements. */
  statements: Statement[]
  /** Position of the `FOR` keyword. */
  position: SourcePosition
}

/** `WHILE condition DO ... END_WHILE`. */
export interface WhileStatement {
  /** Closed tag. */
  kind: 'while'
  /** Loop condition. */
  condition: Expression
  /** Loop body statements. */
  statements: Statement[]
  /** Position of the `WHILE` keyword. */
  position: SourcePosition
}

/** `REPEAT ... UNTIL condition END_REPEAT`. */
export interface RepeatStatement {
  /** Closed tag. */
  kind: 'repeat'
  /** Loop body statements. */
  statements: Statement[]
  /** Loop exit condition. */
  condition: Expression
  /** Position of the `REPEAT` keyword. */
  position: SourcePosition
}

/** `EXIT` — leaves the innermost loop. */
export interface ExitStatement {
  /** Closed tag. */
  kind: 'exit'
  /** Position of the `EXIT` keyword. */
  position: SourcePosition
}

/** `CONTINUE` — starts the next loop iteration. */
export interface ContinueStatement {
  /** Closed tag. */
  kind: 'continue'
  /** Position of the `CONTINUE` keyword. */
  position: SourcePosition
}

/** `RETURN` — leaves the enclosing program or function block. */
export interface ReturnStatement {
  /** Closed tag. */
  kind: 'return'
  /** Position of the `RETURN` keyword. */
  position: SourcePosition
}

/** Every expression of the supported subset. */
export type Expression =
  | LiteralExpression
  | ReferenceExpression
  | CallExpression
  | UnaryExpression
  | BinaryExpression
  | IndexExpression

/** Number, string, or boolean literal. */
export interface LiteralExpression {
  /** Closed tag. */
  kind: 'literal'
  /** Literal value: `number`, `string`, or `boolean`. */
  value: number | string | boolean
  /** Position of the literal token. */
  position: SourcePosition
}

/** A variable or constant reference by name. */
export interface ReferenceExpression {
  /** Closed tag. */
  kind: 'reference'
  /** Upper-cased referenced name. */
  name: string
  /** Position of the name token. */
  position: SourcePosition
}

/** A function call expression `name(args)`. */
export interface CallExpression {
  /** Closed tag. */
  kind: 'call'
  /** Upper-cased called name. */
  name: string
  /** Call arguments, in source order. */
  args: Expression[]
  /** Position of the called name. */
  position: SourcePosition
}

/** Unary `NOT`, `+`, or `-` applied to one operand. */
export interface UnaryExpression {
  /** Closed tag. */
  kind: 'unary'
  /** Operator text: `NOT`, `+`, or `-`. */
  op: 'NOT' | '+' | '-'
  /** Operand expression. */
  operand: Expression
  /** Position of the operator token. */
  position: SourcePosition
}

/** Binary operator application with ST precedence resolved by the parser. */
export interface BinaryExpression {
  /** Closed tag. */
  kind: 'binary'
  /** Operator text, e.g. `AND`, `+`, `<=`. */
  op: string
  /** Left operand. */
  left: Expression
  /** Right operand. */
  right: Expression
  /** Position of the operator token. */
  position: SourcePosition
}

/** Array access `base[index]`. */
export interface IndexExpression {
  /** Closed tag. */
  kind: 'index'
  /** Indexed base expression. */
  base: Expression
  /** Index expression. */
  index: Expression
  /** Position of the opening bracket. */
  position: SourcePosition
}
