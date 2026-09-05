// Behavior of the `st-syntax` validator over the supported ST subset.
import { describe, expect, it } from 'vitest'
import { verifyStSyntax } from '@deepseek-ai/dsh-ia-verifier'

const VALID_PROGRAM = `(* conveyor demo *)
PROGRAM Conveyor
VAR
  Start : BOOL;
  Stop : BOOL;
  Estop AT %I0.2 : BOOL;
  CylA : BOOL := FALSE;
  Count : INT := 0;
  Steps : ARRAY[0..7] OF BOOL;
END_VAR
Start := TRUE;
Count := Count + 1;
Steps[0] := CylA AND NOT Stop;
IF Start AND NOT Stop THEN
  Count := Count * 2;
ELSIF Estop THEN
  Count := 0;
ELSE
  Count := -1;
END_IF
CASE Count OF
  0: Start := FALSE;
  1, 2: Start := TRUE;
  ELSE Start := Stop;
END_CASE
FOR i := 0 TO 7 BY 1 DO
  Steps[i] := FALSE;
END_FOR
WHILE Count < 10 DO
  Count := Count + 1;
END_WHILE
REPEAT
  Count := Count - 1;
UNTIL Count <= 0
END_REPEAT
Result := SQRT(ABS(-4.0)) ** 2;
END_PROGRAM`

describe('st-syntax validator', () => {
  it('passes a valid program using the documented subset', () => {
    const report = verifyStSyntax({ text: VALID_PROGRAM, fileName: 'conveyor.st' })
    expect(report.kind).toBe('st-syntax')
    expect(report.pass).toBe(true)
    expect(report.diagnostics).toEqual([])
    expect(report.evidence).toHaveLength(1)
  })

  it('passes an empty program', () => {
    expect(verifyStSyntax({ text: 'PROGRAM Main END_PROGRAM' }).pass).toBe(true)
  })

  it('reports a lexical error with a position for an invalid character', () => {
    const report = verifyStSyntax({ text: 'PROGRAM Main\nx := y # 1;\nEND_PROGRAM' })
    expect(report.pass).toBe(false)
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: 'st-lex-invalid-char',
      severity: 'error',
      position: { line: 2, column: 8 },
    }))
  })

  it('reports an unterminated comment', () => {
    const report = verifyStSyntax({ text: 'PROGRAM Main (* never closed\nEND_PROGRAM' })
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: 'st-lex-unterminated-comment' }))
  })

  it('reports an unterminated string literal', () => {
    const report = verifyStSyntax({ text: "PROGRAM Main\nx := 'oops;\nEND_PROGRAM" })
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: 'st-lex-unterminated-string' }))
  })

  it('reports a missing PROGRAM header', () => {
    const report = verifyStSyntax({ text: 'x := 1;' })
    expect(report.pass).toBe(false)
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: 'st-parse-error' }))
  })

  it('reports a missing semicolon between statements and recovers to the next one', () => {
    const report = verifyStSyntax({ text: 'PROGRAM Main\nx := 1\ny := 2;\nEND_PROGRAM' })
    expect(report.pass).toBe(false)
    const missingSemicolon = report.diagnostics.find(d => d.code === 'st-parse-error' && d.message.includes('expected `;` after statement'))
    expect(missingSemicolon).toBeDefined()
  })

  it('collects several errors in one run', () => {
    const report = verifyStSyntax({ text: 'PROGRAM Main\nx := ;\ny := } 1;\nEND_PROGRAM' })
    expect(report.diagnostics.filter(d => d.severity === 'error').length).toBeGreaterThan(1)
  })

  it('accepts nested comments and escapes inside strings', () => {
    const source = "PROGRAM Main (* outer (* inner *) still outer *)\nVAR s : STRING := 'it''s fine';\nEND_VAR\nEND_PROGRAM"
    expect(verifyStSyntax({ text: source }).pass).toBe(true)
  })

  it('accepts real literals with exponents', () => {
    expect(verifyStSyntax({ text: 'PROGRAM Main\nVAR r : REAL := 1.5e-3;\nEND_VAR\nEND_PROGRAM' }).pass).toBe(true)
  })

  it('accepts function blocks with local declarations', () => {
    const source = `PROGRAM Main
VAR
  motor : MotorFB;
END_VAR
FUNCTION_BLOCK MotorFB
VAR
  running : BOOL;
END_VAR
running := TRUE;
END_FUNCTION_BLOCK
motor();
END_PROGRAM`
    expect(verifyStSyntax({ text: source }).pass).toBe(true)
  })
})
