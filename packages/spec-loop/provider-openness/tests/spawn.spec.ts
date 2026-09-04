import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { BridgeProcess, buildSpawnArgs, parseListeningLine } from '../src/spawn.ts'
import type { SpawnedChild, SpawnLike } from '../src/spawn.ts'
import type { SpawnConfig } from '../src/types.ts'

const CONFIG: SpawnConfig = {
  command: 'dotnet',
  args: ['OpennessBridge.dll'],
  cwd: 'C:\\bridges',
  port: 0,
  readyTimeoutMs: 1000,
}

/** Fake child that emits scripted stdout/stderr chunks and records kills. */
function fakeChild(stdoutChunks: string[], stderrChunks: string[] = []): SpawnedChild & { killed: boolean } {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const child: SpawnedChild & { killed: boolean } = {
    stdout,
    stderr,
    killed: false,
    kill() {
      this.killed = true
    },
  }
  const timer = setInterval(() => {
    const stdoutChunk = stdoutChunks.shift()
    if (stdoutChunk !== undefined) stdout.emit('data', Buffer.from(stdoutChunk, 'utf8'))
    const stderrChunk = stderrChunks.shift()
    if (stderrChunk !== undefined) stderr.emit('data', Buffer.from(stderrChunk, 'utf8'))
    if (stdoutChunk === undefined && stderrChunk === undefined) clearInterval(timer)
  }, 0)
  return child
}

function spawnLike(child: ReturnType<typeof fakeChild>): SpawnLike & { calls: Array<{ command: string; args: string[]; cwd?: string }> } {
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = []
  const spawn = ((command: string, args: string[], options: { cwd?: string }) => {
    calls.push({ command, args, ...options.cwd === undefined ? {} : { cwd: options.cwd } })
    return child
  }) as unknown as SpawnLike & { calls: typeof calls }
  spawn.calls = calls
  return spawn
}

describe('spawn helpers', () => {
  it('builds the bridge argv with and without a fixed port', () => {
    expect(buildSpawnArgs(CONFIG)).toEqual(['OpennessBridge.dll'])
    expect(buildSpawnArgs({ ...CONFIG, port: 4279 })).toEqual(['OpennessBridge.dll', '--port', '4279'])
  })

  it('extracts the listening URL from the ready line, tolerating partial lines', () => {
    expect(parseListeningLine('log noise\n{"event":"listening","url":"http://127.0.0.1:4279"}\n')).toBe('http://127.0.0.1:4279')
    expect(parseListeningLine('{"event":"listening","url":"http://127.0.0.1:4280"}')).toBe('http://127.0.0.1:4280')
    expect(parseListeningLine('{"event":"starting"}')).toBeUndefined()
    expect(parseListeningLine('{"event":"listening"}')).toBeUndefined()
    expect(parseListeningLine('not json')).toBeUndefined()
    expect(parseListeningLine('{"event":"listening","url":42}')).toBeUndefined()
  })
})

describe('BridgeProcess', () => {
  it('resolves with the reported URL and the spawn argv', async () => {
    const child = fakeChild(['{"event":"listening","url":"http://127.0.0.1:4279"}'])
    const spawn = spawnLike(child)
    const process = await BridgeProcess.start(CONFIG, { spawn })
    expect(process.url).toBe('http://127.0.0.1:4279')
    expect(spawn.calls).toEqual([{ command: 'dotnet', args: ['OpennessBridge.dll'], cwd: 'C:\\bridges' }])
    process.kill()
    expect(child.killed).toBe(true)
  })

  it('appends the port flag when the config pins a port', async () => {
    const child = fakeChild(['{"event":"listening","url":"http://127.0.0.1:4279"}'])
    const spawn = spawnLike(child)
    await BridgeProcess.start({ ...CONFIG, port: 4279 }, { spawn })
    expect(spawn.calls[0]?.args).toEqual(['OpennessBridge.dll', '--port', '4279'])
  })

  it('rejects with the stderr tail when the ready line never arrives', async () => {
    const child = fakeChild([], ['OpennessBridge: cannot start TIA Portal'])
    const spawn = spawnLike(child)
    await expect(BridgeProcess.start({ ...CONFIG, readyTimeoutMs: 50 }, { spawn }))
      .rejects.toThrow(/did not report its listening URL within 50ms; stderr: OpennessBridge: cannot start TIA Portal/)
  })

  it('rejects when the child stdout fails', async () => {
    const child = fakeChild([])
    const spawn = spawnLike(child)
    const start = BridgeProcess.start(CONFIG, { spawn })
    child.stdout.emit('error', new Error('stdout broken'))
    await expect(start).rejects.toThrow(/stdout failed: stdout broken/)
  })
})
