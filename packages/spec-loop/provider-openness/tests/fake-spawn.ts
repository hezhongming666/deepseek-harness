// Fake child-process spawner for spawn-mode adapter tests: emits scripted
// stdout ready lines, records spawn calls and kills, never launches a real
// process.
import { EventEmitter } from 'node:events'
import type { SpawnLike } from '../src/spawn.ts'

export interface FakeSpawnFactory {
  spawn: SpawnLike
  calls: Array<{ command: string; args: string[]; cwd?: string }>
  child: { killed: boolean }
}

/**
 * Build a fake spawner that emits the given stdout chunks on a timer.
 * @param stdoutChunks - stdout text chunks, e.g. the ready line.
 * @returns the spawner plus its recorded calls and kill flag.
 */
export function fakeSpawnFactory(stdoutChunks: string[]): FakeSpawnFactory {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const child = { stdout, stderr, killed: false, kill(): void { this.killed = true } }
  const timer = setInterval(() => {
    const chunk = stdoutChunks.shift()
    if (chunk !== undefined) stdout.emit('data', Buffer.from(chunk, 'utf8'))
    else clearInterval(timer)
  }, 0)
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = []
  const spawn = ((command: string, args: string[], options: { cwd?: string }) => {
    calls.push({ command, args, ...options.cwd === undefined ? {} : { cwd: options.cwd } })
    return child
  }) as SpawnLike
  return { spawn, calls, child }
}
