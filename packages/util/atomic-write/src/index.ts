/**
 * Zero-dependency atomic file replacement and writer coordination.
 * `writeFileAtomic` writes a random-suffix sibling with exclusive create and
 * the caller's permission bits, then renames it over the target, so readers
 * observe either the old or the new complete content and a replaced file ends
 * up with exactly the stated mode. `withFileLock` serializes cross-process
 * writers of one file through a `wx`-created `<file>.lock` sibling, so a
 * read-modify-write cycle can never resurrect a state another writer just
 * replaced; readers stay lock-free because the rename commit is atomic.
 * `readJsonSnapshot`/`writeJsonSnapshot` wrap the same discipline around
 * versioned JSON snapshot files for load-time (synchronous) store restore.
 * @module @deepseek-ai/dsh-atomic-write
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Filesystem options for {@link writeFileAtomic}; `mode` is required so the
 * permission decision stays visible at every call site.
 */
export interface WriteFileAtomicOptions {
  /**
   * Permission bits stamped on the fresh temp inode and carried through the
   * rename (subject to the process umask, like every fresh inode).
   */
  mode: number
  /**
   * Permission bits for parent directories this call creates (subject to the
   * umask; existing directories keep their mode). Omission uses the mkdir
   * default — pass `0o700` when the tree holds user-private data.
   */
  dirMode?: number
}

/**
 * Replace `filename` with `content` in one atomic step, creating parent
 * directories. The content is first written to a random-suffix sibling opened
 * with exclusive create (`wx`): the open refuses to follow a symlink planted
 * at the temp path, and the fresh inode carries `options.mode` through the
 * rename, so replacing a wider-permission file narrows it without a chmod
 * race. The rename also replaces a symlinked target itself instead of writing
 * through to its referent, and the same-directory sibling keeps the rename on
 * one filesystem. On any failure the temp file is removed and the failure
 * rethrown. Crash durability (fsync) is out of scope.
 * @param filename - final path receiving the content.
 * @param content - complete next file content.
 * @param options - permission bits for the replacement inode.
 */
export async function writeFileAtomic(filename: string, content: string, options: WriteFileAtomicOptions): Promise<void> {
  await mkdir(dirname(filename), {
    recursive: true,
    ...options.dirMode === undefined ? {} : { mode: options.dirMode },
  })
  // TODO(settings-atomic-durability): Use a replacement that fsyncs the file
  // and parent directory and preserves owner-only permissions on Windows.
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, content, { mode: options.mode, flag: 'wx' })
    await rename(temp, filename)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/** Whether an exclusive create found an existing lock. */
async function isLockContention(error: unknown, lockPath: string): Promise<boolean> {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'EEXIST') return true
  if (code !== 'EPERM') return false
  try {
    await lstat(lockPath)
    return true
  } catch {
    // Keep the original EPERM authoritative when lock existence is unproven.
    return false
  }
}

/**
 * Writer-lock protocol constants. These are robustness invariants of the
 * cross-process write protocol, not deployment tunables: contention normally
 * resolves within the retry deadline, while expiry fails the contender without
 * guessing whether the existing lock still has an owner.
 */
const LOCK_RETRY_INITIAL_MS = 20
const LOCK_RETRY_MAX_MS = 200
const LOCK_TIMEOUT_MS = 2_000

/**
 * Hold the cross-process writer lock for `filename` around one operation. The
 * lock is a `wx`-created sibling (`<filename>.lock`); paired with the
 * rename-based commit of {@link writeFileAtomic}, readers stay lock-free and
 * only writers contend. `EEXIST` is contention directly; an `EPERM` is
 * contention only when a fresh `lstat` confirms the lock path exists, covering
 * Windows exclusive-create behavior without hiding an unrelated permission
 * failure. Contention backs off exponentially and fails with a timed-out error
 * after the deadline. The contender never removes an existing lock because
 * file age cannot prove that its owner stopped; orphan recovery is an operator
 * action. The parent directory must exist.
 * @param filename - the file whose writers this lock serializes.
 * @param operation - the read-render-commit cycle to run while holding the lock.
 * @returns the operation's result; the lock releases on both outcomes.
 */
export async function withFileLock<T>(
  filename: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = `${filename}.lock`
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let delay = LOCK_RETRY_INITIAL_MS
  for (;;) {
    try {
      await writeFile(lockPath, `${process.pid}\n`, { mode: 0o600, flag: 'wx' })
      break
    } catch (error) {
      if (!await isLockContention(error, lockPath)) throw error
    }
    if (Date.now() >= deadline) {
      throw new Error(`atomic-write: timed out waiting for the writer lock at ${lockPath}`)
    }
    await new Promise(resolve => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS)
  }
  try {
    return await operation()
  } finally {
    await rm(lockPath, { force: true })
  }
}

/** Render any thrown value without letting the render itself throw. */
function renderError(error: unknown): string {
  try {
    return String(error instanceof Error ? error.message : error)
  } catch {
    return '[unrenderable thrown value]'
  }
}

/**
 * Read one versioned JSON snapshot file synchronously — the load-time restore
 * path for services whose Cordis constructors cannot await IO.
 * @param file - the snapshot path.
 * @param expectedVersion - the format version this reader understands.
 * @returns the stored state, or `undefined` when the file does not exist yet
 *   (a fresh store).
 * @throws when the file is unreadable, malformed JSON, not a versioned record,
 *   or carries a different format version — a store never silently degrades.
 */
export function readJsonSnapshot(file: string, expectedVersion: number): unknown {
  if (!existsSync(file)) return undefined
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`atomic-write: cannot read snapshot ${file}: ${renderError(error)}`)
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new Error(`atomic-write: snapshot ${file} is malformed JSON: ${renderError(error)}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`atomic-write: snapshot ${file} must hold a versioned record object`)
  }
  const record = value as { version?: unknown; state?: unknown }
  if (record.version !== expectedVersion) {
    throw new Error(
      `atomic-write: snapshot ${file} has format version ${JSON.stringify(record.version)}, expected ${expectedVersion}`,
    )
  }
  return record.state
}

/**
 * Write one versioned JSON snapshot file, replacing the previous snapshot in
 * one synchronous atomic step: exclusive-create temp sibling, then rename
 * over the target. Parent directories are created with owner-only
 * permissions; the fresh inode carries `0o600`. Crash durability (fsync) is
 * out of scope, matching {@link writeFileAtomic}.
 * @param file - the snapshot path.
 * @param version - the format version stamped on the record.
 * @param state - the complete next store state, JSON-serializable.
 */
export function writeJsonSnapshot(file: string, version: number, state: unknown): void {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new Error(`atomic-write: cannot create the snapshot directory for ${file}: ${renderError(error)}`)
  }
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify({ version, state })}\n`, { mode: 0o600, flag: 'wx' })
    renameSync(temp, file)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // Swallow the cleanup failure: the leftover temp is inert, and the
      // original write failure below stays authoritative.
    }
    throw new Error(`atomic-write: cannot write snapshot ${file}: ${renderError(error)}`)
  }
}
