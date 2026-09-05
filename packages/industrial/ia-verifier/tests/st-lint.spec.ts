// Behavior of the `st-lint` validator: resolution and hygiene rules.
import { describe, expect, it } from 'vitest'
import { verifyStLint } from '@deepseek-ai/dsh-ia-verifier'

const CLEAN = `PROGRAM Conveyor
VAR
  Start : BOOL;
  Stop : BOOL;
  Count : INT := 0;
END_VAR
IF Start AND NOT Stop THEN
  Count := Count + 1;
END_IF
Count := ABS(Count);
END_PROGRAM`

describe('st-lint validator', () => {
  it('passes a program whose references all resolve', () => {
    const report = verifyStLint({ text: CLEAN })
    expect(report.kind).toBe('st-lint')
    expect(report.pass).toBe(true)
    expect(report.diagnostics).toEqual([])
  })

  it('reports an undefined variable reference as an error with a position', () => {
    const report = verifyStLint({ text: 'PROGRAM Main\nVAR x : BOOL;\nEND_VAR\nx := missing;\nEND_PROGRAM' })
    expect(report.pass).toBe(false)
    const undefinedFinding = report.diagnostics.find(d => d.code === 'st-lint-undefined')
    expect(undefinedFinding).toBeDefined()
    expect(undefinedFinding?.severity).toBe('error')
    expect(undefinedFinding?.message).toContain('MISSING')
  })

  it('reports an undefined assignment target', () => {
    const report = verifyStLint({ text: 'PROGRAM Main\nVAR x : BOOL;\nEND_VAR\ny := TRUE;\nEND_PROGRAM' })
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: 'st-lint-undefined' }))
  })

  it('reports duplicate declarations in one scope', () => {
    const report = verifyStLint({ text: 'PROGRAM Main\nVAR x : BOOL; x : INT;\nEND_VAR\nEND_PROGRAM' })
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: 'st-lint-duplicate-var' }))
  })

  it('warns about a declared variable that is never used', () => {
    const report = verifyStLint({ text: 'PROGRAM Main\nVAR x : BOOL; used : BOOL;\nEND_VAR\nused := TRUE;\nEND_PROGRAM' })
    expect(report.pass).toBe(true)
    const unusedFinding = report.diagnostics.find(d => d.code === 'st-lint-unused')
    expect(unusedFinding).toBeDefined()
    expect(unusedFinding?.severity).toBe('warning')
    expect(unusedFinding?.message).toContain('X')
  })

  it('reports an unknown named type that is no declared function block', () => {
    const report = verifyStLint({ text: 'PROGRAM Main\nVAR m : MotorFB;\nEND_VAR\nEND_PROGRAM' })
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: 'st-lint-unknown-type' }))
  })

  it('accepts a named type that names a declared function block', () => {
    const source = `PROGRAM Main
VAR
  m : MotorFB;
END_VAR
FUNCTION_BLOCK MotorFB
END_FUNCTION_BLOCK
m();
END_PROGRAM`
    expect(verifyStLint({ text: source }).pass).toBe(true)
  })

  it('reports duplicate function-block definitions', () => {
    const source = `PROGRAM Main
FUNCTION_BLOCK FB1
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB1
END_FUNCTION_BLOCK
END_PROGRAM`
    expect(verifyStLint({ text: source }).diagnostics)
      .toContainEqual(expect.objectContaining({ code: 'st-lint-duplicate-fb' }))
  })

  it('reports EXIT outside a loop', () => {
    const report = verifyStLint({ text: 'PROGRAM Main\nEXIT;\nEND_PROGRAM' })
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: 'st-lint-loop-control-outside-loop' }))
  })

  it('accepts EXIT and CONTINUE inside a loop', () => {
    const source = 'PROGRAM Main\nVAR i : INT; done : BOOL;\nEND_VAR\nFOR i := 0 TO 9 DO\n  IF done THEN\n    EXIT;\n  END_IF\n  CONTINUE;\nEND_FOR\nEND_PROGRAM'
    expect(verifyStLint({ text: source }).pass).toBe(true)
  })

  it('reports an undeclared FOR loop variable', () => {
    const report = verifyStLint({ text: 'PROGRAM Main\nFOR i := 0 TO 9 DO\nEND_FOR\nEND_PROGRAM' })
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: 'st-lint-undefined' }))
  })

  it('resolves builtin function names without declarations', () => {
    const source = 'PROGRAM Main\nVAR r : REAL;\nEND_VAR\nr := SQRT(ABS(-4.0));\nEND_PROGRAM'
    expect(verifyStLint({ text: source }).pass).toBe(true)
  })

  it('re-reports syntax errors from the same run and fails the verdict', () => {
    const report = verifyStLint({ text: 'PROGRAM Main\nx := ;\nEND_PROGRAM' })
    expect(report.pass).toBe(false)
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: 'st-parse-error' }))
  })

  it('function-block locals resolve against program scope too', () => {
    const source = `PROGRAM Main
VAR
  Global : BOOL;
  fb : Inner;
END_VAR
FUNCTION_BLOCK Inner
VAR
  Local : BOOL;
END_VAR
Local := Global;
END_FUNCTION_BLOCK
END_PROGRAM`
    expect(verifyStLint({ text: source }).pass).toBe(true)
  })
})
