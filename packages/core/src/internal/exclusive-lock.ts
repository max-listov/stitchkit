/**
 * An exclusive lock between processes, held as a file that records its owner.
 *
 * `open(path, 'wx')` is the whole mutual exclusion: the kernel lets exactly one
 * caller create the file. Everything else here is about the lock that outlives
 * its holder. A crashed process cannot unlink its lock, so a lock with no way to
 * tell a dead owner from a slow one either wedges forever or is taken from under
 * a live writer. The rule is that time never proves death: an owner is reclaimed
 * only when it is on THIS machine and its recorded process lifetime is gone.
 * Boot and start identity disambiguate a reused PID; unknown evidence refuses.
 * Age decides exactly one case — a lock with no readable owner at all, left by
 * a process that died between creating the file and writing to it — and only
 * after a grace period.
 *
 * Reclaiming is serialised through a second, short-lived guard file. Without it
 * every waiter sees the same dead owner at the same moment, and the second one
 * to unlink removes the lock the first one has just created — two holders,
 * which is the one outcome a lock exists to prevent.
 *
 * Grown out of the diagnostic journal's lock, which still sits on it; the
 * journal's refusal policy and the reasons it attaches to a refusal are the
 * same code paths as the public lock's.
 */
import { lstat, open, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { z } from 'zod';
import { readLockRecord } from './exclusive-lock-read';
import { machineIdentity } from './process-identity';
import {
  ProcessInstanceSchema,
  type ProcessOwnerEvidence,
  probeProcessOwner,
  readProcessInstance,
} from './process-instance';
import { isRecord } from './typed';

/** Who holds a lock, as its file records it. */
const ExclusiveLockOwnerSchema = z.object({
  pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  host: z.string().min(1),
  acquiredAt: z.string(),
  machine: z.string().min(1).optional().catch(undefined),
  // Missing is a legacy record; explicit null is an unverified modern record.
  process: ProcessInstanceSchema.nullable().optional().catch(null),
});
export type ExclusiveLockOwner = z.infer<typeof ExclusiveLockOwnerSchema>;

/** Why a present lock was not taken. */
export interface ExclusiveLockDiagnosis {
  readonly attribution: 'this-machine' | 'another-machine' | 'unattributable';
  readonly liveness: 'alive' | 'gone' | 'not-probed';
  readonly identity?: ProcessOwnerEvidence['identity'];
  readonly owner: ExclusiveLockOwner | null;
  readonly cause?: unknown;
}

/** A lock this process holds. */
export interface HeldExclusiveLock {
  readonly path: string;
  readonly owner: ExclusiveLockOwner;
  /** The lock was taken from an owner that was provably gone, or never recorded. */
  readonly reclaimed: boolean;
  /** Close the descriptor and remove the file — only if it is still this lock's file. */
  release(): Promise<void>;
}

export interface ExclusiveLockAttemptOptions {
  readonly signal?: AbortSignal;
  readonly mode: number;
  /** Take a lock whose owner is provably gone. `false` refuses every present lock. */
  readonly reclaim: boolean;
  readonly machineIdentity?: string;
  /**
   * How old a lock with no readable owner must be before it is taken. Absent,
   * an ownerless lock is never taken — it may predate owner records.
   */
  readonly ownerlessGraceMs?: number | null;
}

export type ExclusiveLockAttempt =
  | { readonly held: HeldExclusiveLock }
  | {
      /** The `EEXIST` the exclusive create produced. */
      readonly error: unknown;
      /** Present when a reclaim was considered. */
      readonly diagnosis?: ExclusiveLockDiagnosis;
    };

function isCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function readOwner(text: string): ExclusiveLockOwner | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const owner = ExclusiveLockOwnerSchema.safeParse(parsed);
  return owner.success ? owner.data : undefined;
}

/**
 * Whether the recorded owner's pid is ours to probe.
 *
 * Identity decides it when both sides have one, and it survives a rename. Where either side has
 * none — an older lock, or a platform with no identity — the host name is all that is left, and a
 * mismatch there is reported as `unattributable` rather than as a foreign machine: those are
 * different states, and the earlier code collapsed them into a permanent silent refusal.
 */
function attribute(
  owner: ExclusiveLockOwner,
  identity: string | null,
): ExclusiveLockDiagnosis['attribution'] {
  if (identity !== null && owner.machine !== undefined) {
    return owner.machine === identity ? 'this-machine' : 'another-machine';
  }
  return owner.host === hostname() ? 'this-machine' : 'unattributable';
}

async function diagnose(
  owner: ExclusiveLockOwner | undefined,
  declaredIdentity: string | undefined,
): Promise<ExclusiveLockDiagnosis> {
  if (!owner) return { attribution: 'unattributable', liveness: 'not-probed', owner: null };
  const attribution = attribute(owner, await machineIdentity(declaredIdentity));
  if (attribution !== 'this-machine') return { attribution, liveness: 'not-probed', owner };
  return { attribution, ...(await probeProcessOwner(owner.pid, owner.process)), owner };
}

interface LockFileState {
  readonly owner: ExclusiveLockOwner | undefined;
  /** Identity of the file read, so a removal can check it is still the same file. */
  readonly ino: number;
  readonly dev: number;
  readonly mtimeMs: number;
}

async function readLockFile(
  path: string,
  onFailure?: (cause: unknown) => void,
  signal?: AbortSignal,
): Promise<LockFileState | undefined> {
  try {
    const record = await readLockRecord(path, undefined, signal);
    return {
      owner: readOwner(record.text),
      ino: record.info.ino,
      dev: record.info.dev,
      mtimeMs: record.info.mtimeMs,
    };
  } catch (cause) {
    if (!isCode(cause, 'ENOENT')) onFailure?.(cause);
    return undefined;
  }
}

/** Remove `path` only while it is still the file that was read as `ino`. */
async function unlinkIfSame(path: string, ino: number, dev: number): Promise<void> {
  try {
    const current = await lstat(path);
    if (current.ino !== ino || current.dev !== dev || !current.isFile() || current.nlink !== 1)
      return;
    await unlink(path);
  } catch (error) {
    if (!isCode(error, 'ENOENT')) throw error;
  }
}

async function createOwned(
  path: string,
  options: ExclusiveLockAttemptOptions,
  reclaimed: boolean,
): Promise<HeldExclusiveLock> {
  // Identity first: on darwin it may spawn a registry read, and every moment
  // between the create and the owner write is a moment the lock has no owner.
  const identity = await machineIdentity(options.machineIdentity);
  const instance = await readProcessInstance(process.pid);
  const handle = await open(path, 'wx', options.mode);
  const owner: ExclusiveLockOwner = {
    pid: process.pid,
    process: instance,
    host: hostname(),
    acquiredAt: new Date().toISOString(),
    ...(identity !== null && { machine: identity }),
  };
  let ino: number | undefined;
  let dev: number | undefined;
  try {
    const info = await handle.stat();
    ino = info.ino;
    dev = info.dev;
    // The creator owns this descriptor; umask must not silently drop shared-reader rights.
    await handle.chmod(options.mode);
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (ino !== undefined && dev !== undefined)
      await unlinkIfSame(path, ino, dev).catch(() => undefined);
    throw error;
  }
  const ownedInode = ino;
  const ownedDevice = dev;
  let released = false;
  return {
    path,
    owner,
    reclaimed,
    async release() {
      if (released) return;
      released = true;
      try {
        await handle.close();
      } finally {
        // A lock reclaimed from under this holder belongs to someone else now;
        // removing it by name would hand the resource to a third process.
        await unlinkIfSame(path, ownedInode, ownedDevice);
      }
    },
  };
}

function reclaimable(
  state: LockFileState,
  diagnosis: ExclusiveLockDiagnosis,
  graceMs: number | null | undefined,
): boolean {
  if (state.owner) return diagnosis.liveness === 'gone';
  return typeof graceMs === 'number' && Date.now() - state.mtimeMs >= graceMs;
}

/**
 * Take the reclaim guard, re-read the lock under it, and replace the lock only
 * if it is still the dead one. `undefined` means someone else is reclaiming.
 */
async function reclaimUnderGuard(
  path: string,
  options: ExclusiveLockAttemptOptions,
): Promise<HeldExclusiveLock | 'refused' | undefined> {
  const guardPath = `${path}.reclaim`;
  // A stale guard requires the same serialized recovery as a stale lock.
  // Checking its inode and then unlinking without a guard leaves a syscall
  // race in which another reclaimer's newly created guard can be removed.
  const acquired = await attemptExclusiveLock(guardPath, {
    ...options,
    ownerlessGraceMs:
      options.ownerlessGraceMs === undefined ? 5_000 : options.ownerlessGraceMs,
  });
  if (!('held' in acquired)) return undefined;
  const guard = acquired.held;
  try {
    // Re-read under the guard: the lock seen before it may have been reclaimed
    // and re-taken by the previous guard holder, and that one is alive.
    let unsafe = false;
    const state = await readLockFile(
      path,
      () => {
        unsafe = true;
      },
      options.signal,
    );
    if (unsafe) return 'refused';
    if (state) {
      const diagnosis = await diagnose(state.owner, options.machineIdentity);
      if (options.signal?.aborted) return 'refused';
      if (!reclaimable(state, diagnosis, options.ownerlessGraceMs)) return 'refused';
      await unlinkIfSame(path, state.ino, state.dev);
    }
    // An ordinary acquirer never unlinks, but it may create the file between
    // that unlink and this create; it then holds the lock, and this refuses.
    return await createOwned(path, options, state !== undefined).catch((error: unknown) => {
      if (isCode(error, 'EEXIST')) return 'refused' as const;
      throw error;
    });
  } finally {
    await guard.release().catch(() => undefined);
  }
}

/**
 * One attempt at the lock: create it, or — under `reclaim` — replace it when
 * its owner is provably gone. A refusal returns the create's own `EEXIST`, so a
 * caller that surfaced that error keeps surfacing the identical one.
 */
export async function attemptExclusiveLock(
  path: string,
  options: ExclusiveLockAttemptOptions,
): Promise<ExclusiveLockAttempt> {
  try {
    return { held: await createOwned(path, options, false) };
  } catch (error) {
    if (!isCode(error, 'EEXIST')) throw error;
    if (!options.reclaim) return { error };
    let readFailure: unknown;
    const state = await readLockFile(
      path,
      (cause) => {
        readFailure = cause;
      },
      options.signal,
    );
    const diagnosis = {
      ...(await diagnose(state?.owner, options.machineIdentity)),
      ...(readFailure !== undefined && { cause: readFailure }),
    };
    if (options.signal?.aborted) return { error, diagnosis };
    if (!state || !reclaimable(state, diagnosis, options.ownerlessGraceMs)) {
      return { error, diagnosis };
    }
    const reclaimed = await reclaimUnderGuard(path, options);
    if (reclaimed !== undefined && reclaimed !== 'refused') return { held: reclaimed };
    return { error, diagnosis };
  }
}

/** Read the owner a present lock records, for a refusal that has to name it. */
export async function readExclusiveLockOwner(
  path: string,
): Promise<ExclusiveLockOwner | null> {
  return (await readLockFile(path))?.owner ?? null;
}
