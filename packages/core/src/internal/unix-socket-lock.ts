/**
 * The startup lock of one unix socket path: probe, bind and shutdown unlink run under it, across
 * processes, inside a synchronous `createServer`.
 *
 * It is the exclusive lock's file taken synchronously. The file records its owner — this machine
 * and one process lifetime (`recordOwner`) — and a present lock is taken only by the same rule
 * (`diagnoseSync`, `reclaimable`): an owner on this machine whose recorded lifetime is provably
 * over, or this process's own record with no descriptor of it left open. A bare PID never proves
 * death: after a reboot or a PID reuse it names a stranger.
 */
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  type Stats,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { errnoOf } from './errno';
import {
  diagnoseSync,
  type ExclusiveLockOwner,
  readOwner,
  reclaimable,
  recordOwner,
} from './exclusive-lock-owner';
import { OWNER_RECORD_BYTES } from './exclusive-lock-read';
import { machineIdentitySync } from './process-identity';
import { readProcessInstanceSync } from './process-instance';
import { randomHex } from './random-hex';
import type { UnixSocketInode } from './unix-socket';

const LOCK_TIMEOUT_MS = 5_000;
const FIRST_LOCK_RETRY_MS = 10;
const MAX_LOCK_RETRY_MS = 50;
const LOCK_MODE = 0o600;
const MAX_GUARD_ATTEMPTS = 2;
/**
 * A lock file with no readable owner — a record cut short by a crash between create and write —
 * is taken once it is older than any holder keeps it: the liveness probe under
 * the lock has a 2 s deadline and the bind does not wait.
 */
const OWNERLESS_GRACE_MS = 30_000;
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

/** Upper bound on nested `.reclaim` guard recovery depth to prevent unbounded chains. */
export const MAX_RECLAIM_DEPTH = 16;

/** A lock or guard file as read: what the owner rule judges, and the file it was read from. */
interface LockFileState extends UnixSocketInode {
  readonly path: string;
  readonly record: string;
  readonly owner: ExclusiveLockOwner | undefined;
  readonly ownerless: boolean;
  readonly mtimeMs: number;
}

type ReadLockResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'read'; readonly state: LockFileState };

interface StagedLockFile {
  readonly path: string;
  readonly fd: number;
  readonly inode: UnixSocketInode;
}

function syncSleep(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
}

/** Sibling startup lock path for a unix socket path. */
export function unixSocketLockPath(socketPath: string): string {
  return join(dirname(socketPath), `.${basename(socketPath)}.lock`);
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Best-effort descriptor cleanup; never mask the primary error.
  }
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Best-effort cleanup of a private staging file; never mask a lock error.
  }
}

function unlinkIfSameFile(path: string, expected: UnixSocketInode): boolean {
  let current: ReturnType<typeof lstatSync>;
  try {
    current = lstatSync(path, { throwIfNoEntry: false });
  } catch (error) {
    const code = errnoOf(error);
    if (code === 'ENOENT') return true;
    if (code === 'EACCES' || code === 'EPERM' || code === 'ENOTDIR' || code === 'EROFS') {
      return false;
    }
    throw error;
  }
  if (
    current === undefined ||
    !current.isFile() ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino
  ) {
    return current === undefined;
  }
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    const code = errnoOf(error);
    if (code === 'ENOENT') return true;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTDIR' || code === 'EROFS') {
      return false;
    }
    throw error;
  }
}

/**
 * Remove a lock or guard this process published, then close its descriptor. A failure is logged,
 * not thrown: the guarded work has already happened, and its outcome is the caller's answer. The
 * file left behind names this process with no descriptor open on it, which the owner rule judges
 * gone, so the next acquisition takes it.
 */
function releasePublished(path: string, published: StagedLockFile): void {
  try {
    unlinkIfSameFile(path, published.inode);
  } catch (error) {
    console.error(
      `[stitchkit] unix socket startup lock "${path}" could not be removed; it is left for the next start to take`,
      error,
    );
  } finally {
    closeQuietly(published.fd);
  }
}

/** Read the record a descriptor refers to, refusing anything but a small regular file. */
function readRecordAt(fd: number): { info: Stats; record: string } | null {
  const info = fstatSync(fd);
  if (!info.isFile() || info.size > OWNER_RECORD_BYTES) return null;
  const buffer = Buffer.allocUnsafe(OWNER_RECORD_BYTES + 1);
  const bytesRead = readSync(fd, buffer, 0, OWNER_RECORD_BYTES + 1, 0);
  if (bytesRead > OWNER_RECORD_BYTES) return null;
  return { info, record: buffer.subarray(0, bytesRead).toString('utf8') };
}

/** Read a lock or guard file without following a symlink or blocking on a FIFO. */
function readLockSync(path: string): ReadLockResult {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    return errnoOf(error) === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable' };
  }
  try {
    const read = readRecordAt(fd);
    if (read === null) return { kind: 'unreadable' };
    const { info, record } = read;
    return {
      kind: 'read',
      state: {
        path,
        record,
        ...readOwner(record),
        dev: info.dev,
        ino: info.ino,
        mtimeMs: info.mtimeMs,
      },
    };
  } catch {
    return { kind: 'unreadable' };
  } finally {
    closeQuietly(fd);
  }
}

/** The exclusive lock's verdict on a present file: its owner is provably gone, or it has none. */
function isTakeable(state: LockFileState): boolean {
  return reclaimable(state, diagnoseSync(state, undefined), OWNERLESS_GRACE_MS);
}

/**
 * Remove the file that was judged, and only that file. The descriptor pins the judged inode, so no
 * new lock can take its number while the name is compared; the record read again through it proves
 * the pinned file is the judged one rather than a newer lock that reused the number before the pin.
 */
function removeJudgedLockSync(state: LockFileState): boolean {
  let pin: number;
  try {
    pin = openSync(
      state.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    return errnoOf(error) === 'ENOENT';
  }
  try {
    const pinned = readRecordAt(pin);
    if (
      pinned === null ||
      pinned.info.dev !== state.dev ||
      pinned.info.ino !== state.ino ||
      pinned.record !== state.record
    )
      return false;
    return unlinkIfSameFile(state.path, state);
  } catch {
    return false;
  } finally {
    closeQuietly(pin);
  }
}

/**
 * Create a private staged file holding this process's owner record with exact `0o600` permissions
 * even under a restrictive umask (e.g. `umask(0o777)`), returning the open descriptor to pin the
 * inode. The record is complete before the file is linked to its lock name.
 */
function createStagedLockFile(dir: string, prefix: string): StagedLockFile {
  const owner = recordOwner(
    machineIdentitySync(undefined),
    readProcessInstanceSync(process.pid),
  );
  const stagedPath = join(dir, `.${prefix}-${process.pid}-${randomHex(4)}.tmp`);
  const fd = openSync(
    stagedPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    LOCK_MODE,
  );
  try {
    fchmodSync(fd, LOCK_MODE);
    writeSync(fd, `${JSON.stringify(owner)}\n`);
    const info = fstatSync(fd);
    return { path: stagedPath, fd, inode: { dev: info.dev, ino: info.ino } };
  } catch (error) {
    closeQuietly(fd);
    unlinkQuietly(stagedPath);
    throw error;
  }
}

/** Take the `.reclaim` guard of `lockPath`, recovering once from a guard whose owner is gone. */
function acquireReclaimGuard(lockPath: string, depth: number): StagedLockFile | undefined {
  const guardPath = `${lockPath}.reclaim`;
  let guard: StagedLockFile;
  try {
    guard = createStagedLockFile(dirname(lockPath), 'sk-guard');
  } catch (error) {
    const code = errnoOf(error);
    if (code === 'EPERM' || code === 'EACCES' || code === 'EROFS') return undefined;
    throw error;
  }
  let acquired = false;
  try {
    for (let attempt = 0; attempt < MAX_GUARD_ATTEMPTS; attempt += 1) {
      try {
        linkSync(guard.path, guardPath);
        acquired = true;
        return guard;
      } catch (error) {
        const code = errnoOf(error);
        if (code === 'ENAMETOOLONG' || code === 'EPERM' || code === 'EACCES') return undefined;
        if (code !== 'EEXIST') throw error;
        if (attempt === 0 && tryReclaimDeadLock(guardPath, depth + 1)) continue;
        return undefined;
      }
    }
    return undefined;
  } finally {
    unlinkQuietly(guard.path);
    if (!acquired) closeQuietly(guard.fd);
  }
}

/**
 * Reclaim a lock file whose recorded owner is provably gone, serialized through a short-lived
 * atomic `.reclaim` guard file so concurrent reclaimers cannot unlink a winner's live lock.
 *
 * Recovers from an abandoned `.reclaim` guard up to `MAX_RECLAIM_DEPTH`, judges `lockPath` again
 * under the guard, and never follows, reads, or unlinks symlinks at either `lockPath` or
 * `${lockPath}.reclaim`.
 */
export function tryReclaimDeadLock(lockPath: string, depth = 0): boolean {
  const pre = readLockSync(lockPath);
  if (pre.kind === 'absent') return true;
  if (pre.kind === 'unreadable' || !isTakeable(pre.state)) return false;
  if (depth >= MAX_RECLAIM_DEPTH) return false;
  const guard = acquireReclaimGuard(lockPath, depth);
  if (guard === undefined) return false;
  try {
    // Re-read under the guard: the lock judged before it may have been reclaimed and re-taken by
    // the previous guard holder, and that one is alive.
    const current = readLockSync(lockPath);
    if (current.kind === 'absent') return true;
    if (current.kind === 'unreadable' || !isTakeable(current.state)) return false;
    return removeJudgedLockSync(current.state);
  } finally {
    releasePublished(`${lockPath}.reclaim`, guard);
  }
}

/**
 * Serialize startup/probe/bind and shutdown-unlink around one unix socket path across processes.
 *
 * The lock file is published atomically via a staged sibling (`0o600`) + hard link so it never
 * exists without its owner record, keeps its descriptor open while held to pin the inode, and is
 * released only when its `(dev, ino)` still matches the file we linked. A release that fails is
 * logged and never replaces the outcome of `run`.
 */
export function withUnixSocketLockSync<T>(
  socketPath: string,
  run: () => T,
  timeoutMs = LOCK_TIMEOUT_MS,
): T {
  const lockPath = unixSocketLockPath(socketPath);
  const staged = createStagedLockFile(dirname(socketPath), 'sk-lock');
  let acquired = false;
  try {
    const deadline = Date.now() + timeoutMs;
    let delay = FIRST_LOCK_RETRY_MS;
    for (;;) {
      try {
        linkSync(staged.path, lockPath);
        acquired = true;
        break;
      } catch (error) {
        if (errnoOf(error) !== 'EEXIST') throw error;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(
            `[stitchkit] timed out waiting for unix socket startup lock "${lockPath}"`,
            { cause: error },
          );
        }
        if (tryReclaimDeadLock(lockPath)) continue;
        syncSleep(Math.min(delay, remaining));
        delay = Math.min(delay * 2, MAX_LOCK_RETRY_MS);
      }
    }
  } finally {
    unlinkQuietly(staged.path);
    if (!acquired) closeQuietly(staged.fd);
  }

  try {
    return run();
  } finally {
    releasePublished(lockPath, staged);
  }
}
