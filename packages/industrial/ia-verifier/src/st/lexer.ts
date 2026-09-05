/**
 * Deterministic tokenizer for the supported IEC 61131-3 Structured Text
 * subset. It never throws: invalid characters become `invalid` tokens that the
 * syntax validator turns into diagnostics, so one run reports every lexical
 * problem at once.
 * @module @deepseek-ai/dsh-ia-verifier
 */

import type { Diagnostic, SourcePosition } from '../types.ts'

/** Closed token vocabulary of the ST subset. */
export type TokenType =
  | 'ident'
  | 'number'
  | 'string'
  | 'operator'
  | 'keyword'
  | 'address'
  | 'invalid'
  | 'eof'

/** One lexical token with its one-based source position. */
export interface Token {
  /** Token category. */
  type: TokenType
  /** Exact matched source text (upper-cased for keywords and addresses). */
  text: string
  /** One-based line of the first character. */
  line: number
  /** One-based column of the first character. */
  column: number
}

/** ST reserved words of the supported subset, upper-cased. */
const KEYWORDS = new Set([
  'PROGRAM', 'END_PROGRAM',
  'VAR', 'END_VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_TEMP', 'CONSTANT',
  'FUNCTION_BLOCK', 'END_FUNCTION_BLOCK', 'FUNCTION', 'END_FUNCTION',
  'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF',
  'CASE', 'OF', 'END_CASE',
  'FOR', 'TO', 'BY', 'DO', 'END_FOR',
  'WHILE', 'END_WHILE',
  'REPEAT', 'UNTIL', 'END_REPEAT',
  'EXIT', 'CONTINUE', 'RETURN',
  'ARRAY', 'AT',
  'NOT', 'AND', 'OR', 'XOR', 'MOD',
  'TRUE', 'FALSE',
])

/** Multi-character operators, longest first. */
const LONG_OPERATORS = [':=', '..', '**', '<=', '>=', '<>'] as const

/** Single-character operators and punctuation. */
const SHORT_OPERATORS = new Set('+-*/<>=&()[],;:.')

/**
 * Tokenize ST source text.
 * @param source - the source text to tokenize.
 * @returns the token stream ending in one `eof` token, plus lexical diagnostics
 *   (one per invalid character, always severity `'error'`).
 */
export function tokenize(source: string): { tokens: Token[]; diagnostics: Diagnostic[] } {
  const tokens: Token[] = []
  const diagnostics: Diagnostic[] = []
  let index = 0
  let line = 1
  let column = 1

  /** Advance one character, maintaining the position counters. */
  function advance(): string {
    const char = source[index] ?? ''
    index += 1
    if (char === '\n') {
      line += 1
      column = 1
    } else {
      column += 1
    }
    return char
  }

  /** Peek at the character `offset` ahead, without advancing. */
  function peek(offset = 0): string {
    return source[index + offset] ?? ''
  }

  /** The position where the next token will start. */
  function position(): SourcePosition {
    return { line, column }
  }

  /** Emit one token at the given start position. */
  function emit(type: TokenType, text: string, at: SourcePosition): void {
    tokens.push({ type, text, line: at.line, column: at.column })
  }

  /** Emit an invalid-character diagnostic. */
  function invalid(char: string, at: SourcePosition): void {
    diagnostics.push({
      code: 'st-lex-invalid-char',
      message: `unexpected character ${JSON.stringify(char)}`,
      severity: 'error',
      position: at,
    })
    emit('invalid', char, at)
  }

  /** Skip a `(* ... *)` comment, which may nest per IEC 61131-3. */
  function skipComment(at: SourcePosition): void {
    let depth = 1
    while (depth > 0 && index < source.length) {
      if (peek() === '(' && peek(1) === '*') {
        depth += 1
        advance()
        advance()
      } else if (peek() === '*' && peek(1) === ')') {
        depth -= 1
        advance()
        advance()
      } else {
        advance()
      }
    }
    if (depth > 0) {
      diagnostics.push({
        code: 'st-lex-unterminated-comment',
        message: 'unterminated comment: missing `*)`',
        severity: 'error',
        position: at,
      })
    }
  }

  while (index < source.length) {
    const at = position()
    const char = source[index] ?? ''

    if (char === ' ' || char === '\t' || char === '\r' || char === '\n') {
      advance()
      continue
    }
    if (char === '(' && peek(1) === '*') {
      advance()
      advance()
      skipComment(at)
      continue
    }
    if (/[A-Za-z_]/.test(char)) {
      let text = ''
      while (/[A-Za-z0-9_]/.test(peek())) text += advance()
      const upper = text.toUpperCase()
      emit(KEYWORDS.has(upper) ? 'keyword' : 'ident', upper, at)
      continue
    }
    if (/[0-9]/.test(char)) {
      let text = ''
      while (/[0-9]/.test(peek())) text += advance()
      if (peek() === '.' && peek(1) !== '.') {
        text += advance()
        while (/[0-9]/.test(peek())) text += advance()
      }
      if (peek() === 'e' || peek() === 'E') {
        let lookahead = 2
        if (peek(1) === '+' || peek(1) === '-') lookahead = 3
        if (/[0-9]/.test(peek(lookahead - 1))) {
          text += advance()
          if (peek() === '+' || peek() === '-') text += advance()
          while (/[0-9]/.test(peek())) text += advance()
        }
      }
      emit('number', text, at)
      continue
    }
    if (char === "'") {
      let text = ''
      advance()
      let closed = false
      while (index < source.length) {
        if (peek() === "'") {
          if (peek(1) === "'") {
            text += advance()
            text += advance()
            continue
          }
          advance()
          closed = true
          break
        }
        text += advance()
      }
      emit('string', text, at)
      if (!closed) {
        diagnostics.push({
          code: 'st-lex-unterminated-string',
          message: "unterminated string literal: missing closing `'`",
          severity: 'error',
          position: at,
        })
      }
      continue
    }
    if (char === '%') {
      let text = advance()
      while (/[A-Za-z0-9_.]/.test(peek())) text += advance()
      emit('address', text.toUpperCase(), at)
      continue
    }
    const long = LONG_OPERATORS.find(op => source.startsWith(op, index))
    if (long !== undefined) {
      for (let i = 0; i < long.length; i++) advance()
      emit('operator', long, at)
      continue
    }
    if (SHORT_OPERATORS.has(char)) {
      advance()
      emit('operator', char, at)
      continue
    }
    advance()
    invalid(char, at)
  }

  const at = position()
  tokens.push({ type: 'eof', text: '', line: at.line, column: at.column })
  return { tokens, diagnostics }
}
