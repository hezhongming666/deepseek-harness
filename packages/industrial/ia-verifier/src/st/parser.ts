/**
 * Recursive-descent parser for the supported IEC 61131-3 Structured Text
 * subset. Parse problems are collected as diagnostics, never thrown; after a
 * problem the cursor recovers at the next `;` or block keyword so one run
 * reports as many problems as possible without stalling.
 * @module @deepseek-ai/dsh-ia-verifier
 */

import type { Diagnostic, SourcePosition } from '../types.ts'
import type {
  CaseArm,
  CaseStatement,
  Expression,
  ForStatement,
  FunctionBlock,
  IfArm,
  IfStatement,
  Program,
  Statement,
  StType,
  VarDecl,
} from './ast.ts'
import { tokenize } from './lexer.ts'
import type { Token } from './lexer.ts'

/** Keywords that open or close a declaration/statement block, used for recovery. */
const BLOCK_KEYWORDS = new Set([
  'VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_TEMP', 'END_VAR',
  'FUNCTION_BLOCK', 'END_FUNCTION_BLOCK', 'FUNCTION', 'END_FUNCTION',
  'IF', 'ELSIF', 'ELSE', 'END_IF', 'CASE', 'END_CASE',
  'FOR', 'END_FOR', 'WHILE', 'END_WHILE', 'REPEAT', 'END_REPEAT',
  'PROGRAM', 'END_PROGRAM',
])

/** Keywords that start a statement. */
const STATEMENT_START = new Set(['IF', 'CASE', 'FOR', 'WHILE', 'REPEAT', 'EXIT', 'CONTINUE', 'RETURN'])

/** Operator precedence levels, lowest first; `**` binds tightest before unary. */
const BINARY_LEVELS: ReadonlyArray<readonly string[]> = [
  ['OR', 'XOR'],
  ['AND'],
  ['=', '<>', '<', '>', '<=', '>='],
  ['+', '-'],
  ['*', '/', 'MOD'],
]

/** Unary operators of the subset. */
const UNARY_OPERATORS = new Set(['NOT', '+', '-'])

/** Elementary type names recognized by the built-in validators. */
const ELEMENTARY_TYPES = new Set(['BOOL', 'BYTE', 'WORD', 'INT', 'DINT', 'REAL', 'LREAL', 'STRING', 'TIME'])

/**
 * Parse one ST source text.
 * @param source - the source text to parse.
 * @returns the parsed program when one opened, plus all diagnostics (lexical
 *   and syntactic), always severity `'error'` for parse problems.
 */
export function parse(source: string): { program: Program | undefined; diagnostics: Diagnostic[] } {
  const { tokens, diagnostics } = tokenize(source)
  const parser = new Parser(tokens, diagnostics)
  const program = parser.parseProgram()
  return { program, diagnostics }
}

/** Fallback token returned when the cursor leaves the stream; the stream always ends in `eof`. */
const EOF: Token = { type: 'eof', text: '', line: 0, column: 0 }

/** Cursor-driven recursive-descent parser over a token stream. */
class Parser {
  private index = 0

  /**
   * Construct the parser over a tokenized stream.
   * @param tokens - the token stream ending in `eof`.
   * @param diagnostics - the shared diagnostic sink.
   */
  constructor(
    private readonly tokens: readonly Token[],
    private readonly diagnostics: Diagnostic[],
  ) {}

  /** The token under the cursor. */
  private current(): Token {
    return this.tokens[this.index] ?? EOF
  }

  /** The token `offset` ahead of the cursor. */
  private peek(offset = 1): Token {
    return this.tokens[Math.min(this.index + offset, Math.max(this.tokens.length - 1, 0))] ?? EOF
  }

  /** Advance the cursor and return the token that was current. */
  private advance(): Token {
    const token = this.current()
    if (token.type !== 'eof') this.index += 1
    return token
  }

  /** Whether the current token is an operator with the given text. */
  private atOperator(text: string): boolean {
    const token = this.current()
    return token.type === 'operator' && token.text === text
  }

  /** Whether the current token is the given upper-cased keyword. */
  private atKeyword(keyword: string): boolean {
    const token = this.current()
    return token.type === 'keyword' && token.text === keyword
  }

  /** Whether the current token starts a statement. */
  private atStatementStart(): boolean {
    const token = this.current()
    return token.type === 'ident' || (token.type === 'keyword' && STATEMENT_START.has(token.text))
  }

  /** Record one parse diagnostic at a token's position. */
  private fail(message: string, at: Token = this.current()): void {
    this.diagnostics.push({
      code: 'st-parse-error',
      message,
      severity: 'error',
      position: { line: at.line, column: at.column },
    })
  }

  /**
   * Record one diagnostic and move the cursor past the problem: synchronize
   * at the next `;` or block keyword, advancing one token when that point is
   * already under the cursor, so recovery always makes progress.
   * @param message - the problem description.
   */
  private recover(message: string): void {
    this.fail(message)
    const before = this.index
    this.synchronize()
    if (this.index === before) this.advance()
  }

  /** Consume one expected token or record a diagnostic and stay in place. */
  private expect(type: Token['type'], message: string, text?: string): Token | undefined {
    const token = this.current()
    if (token.type !== type || (text !== undefined && token.text !== text)) {
      this.fail(`${message}; found ${describe(token)}`)
      return undefined
    }
    return this.advance()
  }

  /** Consume one expected keyword or record a diagnostic and stay in place. */
  private expectKeyword(keyword: string, message: string): boolean {
    if (this.atKeyword(keyword)) {
      this.advance()
      return true
    }
    this.fail(`${message}; found ${describe(this.current())}`)
    return false
  }

  /** Consume one expected operator or record a diagnostic and stay in place. */
  private expectOperator(text: string, message: string): boolean {
    if (this.atOperator(text)) {
      this.advance()
      return true
    }
    this.fail(`${message}; found ${describe(this.current())}`)
    return false
  }

  /** Skip tokens until a `;` or a block keyword, so parsing resumes safely. */
  private synchronize(): void {
    while (this.current().type !== 'eof') {
      if (this.atOperator(';') || (this.current().type === 'keyword' && BLOCK_KEYWORDS.has(this.current().text))) {
        return
      }
      this.advance()
    }
  }

  /** Position of the token under the cursor. */
  private position(): SourcePosition {
    const token = this.current()
    return { line: token.line, column: token.column }
  }

  /** Whether a parsed statement ends with `;` in the source grammar. */
  private needsSemicolon(statement: Statement): boolean {
    switch (statement.kind) {
      case 'assignment':
      case 'call':
      case 'exit':
      case 'continue':
      case 'return':
        return true
      case 'if':
      case 'case':
      case 'for':
      case 'while':
      case 'repeat':
        return false
    }
  }

  /** Parse `PROGRAM name ... END_PROGRAM`. */
  parseProgram(): Program | undefined {
    if (this.current().type === 'eof') {
      this.fail('expected PROGRAM, found end of input')
      return undefined
    }
    if (!this.expectKeyword('PROGRAM', 'expected PROGRAM')) return undefined
    const position = this.position()
    const nameToken = this.expect('ident', 'expected program name')
    if (nameToken === undefined) {
      this.recover('expected program name')
      return undefined
    }
    const program: Program = {
      kind: 'program',
      name: nameToken.text,
      declarations: [],
      functionBlocks: [],
      statements: [],
      position,
    }
    while (this.current().type !== 'eof' && !this.atKeyword('END_PROGRAM')) {
      if (this.current().type === 'keyword' && this.current().text.startsWith('VAR')) {
        program.declarations.push(...this.parseVarBlock())
      } else if (this.atKeyword('FUNCTION_BLOCK')) {
        const block = this.parseFunctionBlock()
        if (block !== undefined) program.functionBlocks.push(block)
      } else {
        const statement = this.parseStatement()
        if (statement !== undefined) program.statements.push(statement)
        if (statement !== undefined && this.needsSemicolon(statement)) {
          this.expectOperator(';', 'expected `;` after statement')
        }
        if (this.current().type !== 'eof' && !this.atKeyword('END_PROGRAM')
          && !this.atOperator(';') && !(this.current().type === 'keyword' && this.current().text.startsWith('VAR'))
          && !this.atKeyword('FUNCTION_BLOCK') && !this.atStatementStart()) {
          this.recover(`unexpected ${describe(this.current())}`)
        }
      }
    }
    this.expectKeyword('END_PROGRAM', 'expected END_PROGRAM')
    return program
  }

  /** Parse one `VAR ... END_VAR` block into declarations. */
  private parseVarBlock(): VarDecl[] {
    const declarations: VarDecl[] = []
    this.advance()
    while (this.current().type !== 'eof' && !this.atKeyword('END_VAR')) {
      if (this.atOperator(';')) {
        this.advance()
        continue
      }
      const decl = this.parseVarDecl()
      if (decl !== undefined) declarations.push(decl)
      if (!this.atKeyword('END_VAR')) this.expectOperator(';', 'expected `;` between declarations')
    }
    this.expectKeyword('END_VAR', 'expected END_VAR')
    return declarations
  }

  /** Parse one variable declaration line: names (AT addr)? `:` type (`:=` expr)? */
  private parseVarDecl(): VarDecl | undefined {
    const position = this.position()
    const names: string[] = []
    while (this.current().type === 'ident') names.push(this.advance().text)
    if (names.length === 0) {
      this.recover('expected variable name in declaration')
      return undefined
    }
    let address: string | undefined
    if (this.atKeyword('AT')) {
      this.advance()
      const addressToken = this.expect('address', 'expected hardware address after AT')
      address = addressToken?.text
    }
    this.expectOperator(':', 'expected `:` before type')
    const type = this.parseType()
    if (type === undefined) return undefined
    const decl: VarDecl = { names, type, position }
    if (address !== undefined) decl.address = address
    if (this.atOperator(':=')) {
      this.advance()
      decl.init = this.parseExpression()
    }
    return decl
  }

  /** Parse one type reference: elementary, `ARRAY [..] OF`, or named. */
  private parseType(): StType | undefined {
    const token = this.current()
    if (token.type === 'ident' || (token.type === 'keyword' && token.text !== 'ARRAY')) {
      this.advance()
      if (ELEMENTARY_TYPES.has(token.text)) return { kind: 'elementary', name: token.text }
      return { kind: 'named', name: token.text }
    }
    if (this.atKeyword('ARRAY')) {
      this.advance()
      this.expectOperator('[', 'expected `[` after ARRAY')
      const lower = this.expect('number', 'expected lower index bound')
      this.expectOperator('..', 'expected `..` between index bounds')
      const upper = this.expect('number', 'expected upper index bound')
      this.expectOperator(']', 'expected `]` after index bounds')
      this.expectKeyword('OF', 'expected OF after array bounds')
      const element = this.parseType()
      if (lower === undefined || upper === undefined || element === undefined) {
        this.recover('invalid ARRAY type')
        return undefined
      }
      return { kind: 'array', lower: Number(lower.text), upper: Number(upper.text), element }
    }
    this.recover('expected type name or ARRAY')
    return undefined
  }

  /** Parse one `FUNCTION_BLOCK name ... END_FUNCTION_BLOCK`. */
  private parseFunctionBlock(): FunctionBlock | undefined {
    const position = this.position()
    this.advance()
    const nameToken = this.expect('ident', 'expected function-block name')
    if (nameToken === undefined) {
      this.recover('expected function-block name')
      return undefined
    }
    const block: FunctionBlock = { kind: 'function-block', name: nameToken.text, declarations: [], statements: [], position }
    while (this.current().type !== 'eof' && !this.atKeyword('END_FUNCTION_BLOCK')) {
      if (this.current().type === 'keyword' && this.current().text.startsWith('VAR')) {
        block.declarations.push(...this.parseVarBlock())
      } else {
        const statement = this.parseStatement()
        if (statement !== undefined) block.statements.push(statement)
        if (statement !== undefined && this.needsSemicolon(statement)) {
          this.expectOperator(';', 'expected `;` after statement')
        }
        if (this.current().type !== 'eof' && !this.atKeyword('END_FUNCTION_BLOCK')
          && !this.atOperator(';') && !(this.current().type === 'keyword' && this.current().text.startsWith('VAR'))
          && !this.atStatementStart()) {
          this.recover(`unexpected ${describe(this.current())}`)
        }
      }
    }
    this.expectKeyword('END_FUNCTION_BLOCK', 'expected END_FUNCTION_BLOCK')
    return block
  }

  /** Parse one statement of the subset. */
  private parseStatement(): Statement | undefined {
    if (this.atKeyword('IF')) return this.parseIf()
    if (this.atKeyword('CASE')) return this.parseCase()
    if (this.atKeyword('FOR')) return this.parseFor()
    if (this.atKeyword('WHILE')) return this.parseWhile()
    if (this.atKeyword('REPEAT')) return this.parseRepeat()
    if (this.atKeyword('EXIT')) return this.parseLoopControl('exit')
    if (this.atKeyword('CONTINUE')) return this.parseLoopControl('continue')
    if (this.atKeyword('RETURN')) return this.parseLoopControl('return')
    if (this.current().type !== 'ident') {
      this.recover(`expected statement; found ${describe(this.current())}`)
      return undefined
    }
    if (this.peek().type === 'operator' && this.peek().text === '(') {
      const name = this.advance()
      this.advance()
      const args = this.parseArguments()
      return { kind: 'call', name: name.text, args, position: { line: name.line, column: name.column } }
    }
    const target = this.parseExpression()
    const assign = this.current()
    if (!this.expectOperator(':=', 'expected `:=` after assignment target')) {
      this.recover('expected `:=` after assignment target')
      return undefined
    }
    const value = this.parseExpression()
    return { kind: 'assignment', target, value, position: { line: assign.line, column: assign.column } }
  }

  /** Parse `IF ... THEN ... (ELSIF ...)* (ELSE ...)? END_IF`. */
  private parseIf(): Statement {
    const position = this.position()
    this.advance()
    const arms: IfArm[] = []
    const condition = this.parseExpression()
    this.expectKeyword('THEN', 'expected THEN after IF condition')
    arms.push({ condition, statements: this.parseStatementList(new Set(['ELSIF', 'ELSE', 'END_IF'])) })
    while (this.atKeyword('ELSIF')) {
      this.advance()
      const armCondition = this.parseExpression()
      this.expectKeyword('THEN', 'expected THEN after ELSIF condition')
      arms.push({ condition: armCondition, statements: this.parseStatementList(new Set(['ELSIF', 'ELSE', 'END_IF'])) })
    }
    const statement: IfStatement = { kind: 'if', arms, position }
    if (this.atKeyword('ELSE')) {
      this.advance()
      statement.elseArm = this.parseStatementList(new Set(['END_IF']))
    }
    this.expectKeyword('END_IF', 'expected END_IF')
    return statement
  }

  /** Parse `CASE selector OF arms... (ELSE ...)? END_CASE`. */
  private parseCase(): Statement {
    const position = this.position()
    this.advance()
    const selector = this.parseExpression()
    this.expectKeyword('OF', 'expected OF after CASE selector')
    const arms: CaseArm[] = []
    while (this.current().type !== 'eof' && !this.atKeyword('ELSE') && !this.atKeyword('END_CASE')) {
      const labels: Expression[] = [this.parseExpression()]
      while (this.atOperator(',')) {
        this.advance()
        labels.push(this.parseExpression())
      }
      this.expectOperator(':', 'expected `:` after case labels')
      arms.push({ labels, statements: this.parseStatementList(new Set(['ELSE', 'END_CASE']), { labels: true }) })
    }
    const statement: CaseStatement = { kind: 'case', selector, arms, position }
    if (this.atKeyword('ELSE')) {
      this.advance()
      statement.elseArm = this.parseStatementList(new Set(['END_CASE']))
    }
    this.expectKeyword('END_CASE', 'expected END_CASE')
    return statement
  }

  /** Parse `FOR var := from TO to (BY by)? DO ... END_FOR`. */
  private parseFor(): Statement {
    const position = this.position()
    this.advance()
    const variable = this.expect('ident', 'expected loop variable after FOR')
    this.expectOperator(':=', 'expected `:=` after loop variable')
    const from = this.parseExpression()
    this.expectKeyword('TO', 'expected TO in FOR loop')
    const to = this.parseExpression()
    const statement: ForStatement = {
      kind: 'for',
      variable: variable?.text ?? '',
      from,
      to,
      statements: [],
      position,
    }
    if (this.atKeyword('BY')) {
      this.advance()
      statement.by = this.parseExpression()
    }
    this.expectKeyword('DO', 'expected DO in FOR loop')
    statement.statements = this.parseStatementList(new Set(['END_FOR']))
    this.expectKeyword('END_FOR', 'expected END_FOR')
    return statement
  }

  /** Parse `WHILE condition DO ... END_WHILE`. */
  private parseWhile(): Statement {
    const position = this.position()
    this.advance()
    const condition = this.parseExpression()
    this.expectKeyword('DO', 'expected DO after WHILE condition')
    const statements = this.parseStatementList(new Set(['END_WHILE']))
    this.expectKeyword('END_WHILE', 'expected END_WHILE')
    return { kind: 'while', condition, statements, position }
  }

  /** Parse `REPEAT ... UNTIL condition END_REPEAT`. */
  private parseRepeat(): Statement {
    const position = this.position()
    this.advance()
    const statements = this.parseStatementList(new Set(['UNTIL']))
    this.expectKeyword('UNTIL', 'expected UNTIL in REPEAT loop')
    const condition = this.parseExpression()
    this.expectKeyword('END_REPEAT', 'expected END_REPEAT')
    return { kind: 'repeat', statements, condition, position }
  }

  /** Parse a bare `EXIT`, `CONTINUE`, or `RETURN` statement. */
  private parseLoopControl(kind: 'exit' | 'continue' | 'return'): Statement {
    const position = this.position()
    this.advance()
    return { kind, position }
  }

  /**
   * Whether the cursor sits at the start of a CASE label list: a number,
   * identifier, or boolean literal followed by `:` or `,` (the latter covers
   * multi-label arms such as `1, 2:`).
   */
  private atCaseLabelStart(): boolean {
    const token = this.current()
    const labelToken = token.type === 'number' || token.type === 'ident'
      || (token.type === 'keyword' && (token.text === 'TRUE' || token.text === 'FALSE'))
    if (!labelToken) return false
    return this.peek().type === 'operator' && (this.peek().text === ':' || this.peek().text === ',')
  }

  /**
   * Parse statements until one of the stop keywords or EOF.
   * @param stopKeywords - upper-cased keywords that end the statement list.
   * @param options - `labels: true` additionally stops at a CASE label start.
   * @returns the parsed statements; simple statements end at a `;`, which this
   *   method consumes.
   */
  private parseStatementList(stopKeywords: ReadonlySet<string>, options: { labels?: boolean } = {}): Statement[] {
    const statements: Statement[] = []
    const atStop = (): boolean => {
      if (this.current().type === 'eof') return true
      if (this.current().type === 'keyword' && stopKeywords.has(this.current().text)) return true
      if (options.labels === true && this.atCaseLabelStart()) return true
      return false
    }
    while (!atStop()) {
      if (this.atOperator(';')) {
        this.advance()
        continue
      }
      const statement = this.parseStatement()
      if (statement !== undefined) statements.push(statement)
      if (statement !== undefined && this.needsSemicolon(statement)) {
        this.expectOperator(';', 'expected `;` after statement')
      }
      if (!atStop() && !this.atOperator(';') && !this.atStatementStart()
        && !(options.labels === true && this.atCaseLabelStart())) {
        this.recover(`unexpected ${describe(this.current())}`)
      }
    }
    return statements
  }

  /** Parse an expression with operator precedence. */
  private parseExpression(): Expression {
    return this.parseBinary(0)
  }

  /** Parse binary expressions at the given precedence level or above. */
  private parseBinary(level: number): Expression {
    if (level >= BINARY_LEVELS.length) return this.parseUnary()
    let left = this.parseBinary(level + 1)
    const operators = BINARY_LEVELS.at(level)
    if (operators === undefined) return left
    while ((this.current().type === 'operator' || this.current().type === 'keyword')
      && operators.includes(this.current().text)) {
      const operator = this.advance()
      const right = this.parseBinary(level + 1)
      left = {
        kind: 'binary',
        op: operator.text,
        left,
        right,
        position: { line: operator.line, column: operator.column },
      }
    }
    return left
  }

  /** Parse a unary expression: `NOT`/`+`/`-` applied to a power operand. */
  private parseUnary(): Expression {
    const token = this.current()
    if ((token.type === 'operator' || token.type === 'keyword') && UNARY_OPERATORS.has(token.text)) {
      this.advance()
      const operand = this.parseUnary()
      return { kind: 'unary', op: token.text as 'NOT' | '+' | '-', operand, position: { line: token.line, column: token.column } }
    }
    return this.parsePower()
  }

  /** Parse the right-associative `**` level. */
  private parsePower(): Expression {
    const base = this.parsePrimary()
    if (this.atOperator('**')) {
      const operator = this.advance()
      const exponent = this.parsePower()
      return { kind: 'binary', op: '**', left: base, right: exponent, position: { line: operator.line, column: operator.column } }
    }
    return base
  }

  /** Parse one primary expression with optional trailing call/index suffixes. */
  private parsePrimary(): Expression {
    const token = this.current()
    if (token.type === 'number') {
      this.advance()
      return { kind: 'literal', value: Number(token.text), position: { line: token.line, column: token.column } }
    }
    if (token.type === 'string') {
      this.advance()
      return { kind: 'literal', value: token.text, position: { line: token.line, column: token.column } }
    }
    if (token.type === 'keyword' && (token.text === 'TRUE' || token.text === 'FALSE')) {
      this.advance()
      return { kind: 'literal', value: token.text === 'TRUE', position: { line: token.line, column: token.column } }
    }
    if (token.type === 'ident') {
      this.advance()
      let expression: Expression = { kind: 'reference', name: token.text, position: { line: token.line, column: token.column } }
      while (true) {
        if (this.atOperator('(')) {
          this.advance()
          const reference: Expression = expression
          if (reference.kind !== 'reference') {
            this.fail('only a name can be called')
            this.parseArguments()
            break
          }
          expression = {
            kind: 'call',
            name: reference.name,
            args: this.parseArguments(),
            position: reference.position,
          }
        } else if (this.atOperator('[')) {
          const bracket = this.advance()
          const index = this.parseExpression()
          this.expectOperator(']', 'expected `]` after index')
          expression = { kind: 'index', base: expression, index, position: { line: bracket.line, column: bracket.column } }
        } else {
          break
        }
      }
      return expression
    }
    if (this.atOperator('(')) {
      this.advance()
      const inner = this.parseExpression()
      this.expectOperator(')', 'expected `)` after expression')
      return inner
    }
    this.fail(`expected expression; found ${describe(token)}`)
    this.advance()
    return { kind: 'literal', value: 0, position: { line: token.line, column: token.column } }
  }

  /** Parse a comma-separated argument list after an opening `(`. */
  private parseArguments(): Expression[] {
    const args: Expression[] = []
    if (this.atOperator(')')) {
      this.advance()
      return args
    }
    while (true) {
      args.push(this.parseExpression())
      if (this.atOperator(',')) {
        this.advance()
        continue
      }
      this.expectOperator(')', 'expected `)` after arguments')
      return args
    }
  }
}

/** One-line human description of a token for diagnostics. */
function describe(token: Token): string {
  if (token.type === 'eof') return 'end of input'
  if (token.type === 'invalid') return `invalid character ${JSON.stringify(token.text)}`
  return `${token.type} ${JSON.stringify(token.text)}`
}
