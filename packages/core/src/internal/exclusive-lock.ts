/**
 * An exclusive lock between processes, held as a file that records its owner.
 *
 * The owner record is written to a private temporary file first and the file is
 * then hard-linked to the lock name: `link` fails with `EEXIST` for all but one
 * caller, and the name never exists without a complete owner record. Everything
 * else here is about the lock that outlives its holder. A crashed process cannot unlink its lock, so a lock with no way to
 * tell a dead owner from a slow one either wedges forever or is taken from under
 * a live writer. The rule is that time never proves death: an owner is reclaimed
 * only when it is on THIS machine and its recorded process lifetime is gone.
 * Boot and start identity disambiguate a reused PID; unknown evidence refuses.
 * Age decides exactly one case, and only when the caller opts in: a lock file
 * with no readable owner at all, which this code never produces but an older
 * writer could leave behind.
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
import { randomUUID } from 'node:crypto';
import { lstat, open, readdir, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { AtomicFilePublicationError, publishAtomicFile } from './atomic-publication';
import { LockRecordError, readLockRecord } from './exclusive-lock-read';
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
  /** Refuse a released, replaced or changed descriptor/path generation. */
  assertHeld(): Promise<void>;
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
   * How old a lock file with no readable owner must be before it is taken. Absent
   * or `null`, such a file is never taken: it may belong to a live older writer.
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

function readOwner(text: string): {
  owner: ExclusiveLockOwner | undefined;
  ownerless: boolean;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { owner: undefined, ownerless: true };
  }
  const owner = ExclusiveLockOwnerSchema.safeParse(parsed);
  if (owner.success) return { owner: owner.data, ownerless: false };
  // A readable legacy owner (including a pid/token record without host) is
  // unknown evidence, not an ownerless create interrupted before its write.
  // Do not invent a machine identity or take it from a live older writer by age.
  const ownerlike =
    isRecord(parsed) &&
    ['pid', 'token', 'host', 'machine', 'process', 'acquiredAt'].some((key) =>
      Object.hasOwn(parsed, key),
    );
  return { owner: undefined, ownerless: !ownerlike };
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
  readonly ownerless: boolean;
  /** Identity of the file read, so a removal can check it is still the same file. */
  readonly ino: number;
  readonly dev: number;
  readonly mtimeMs: number;
  /** The staging name still hard-linked to the lock: its holder stopped between link and unlink. */
  readonly stagedName?: string;
}

// Each level appends a guard and repeats identity/record IO. Ordinary recovery needs
// one level; a finite chain also refuses before pathological names or unbounded IO.
const MAX_RECLAIM_DEPTH = 16;
// The reclaim guard is internal machinery with its own bounded stale rule: this library
// publishes a guard with its owner already recorded, so only an empty guard left by an older
// writer is taken by age. Unset, the guard uses this bound; an explicit `ownerlessGraceMs`
// (a number, or `null` to refuse) governs the guard as well. The lock itself never uses it.
const STALE_GUARD_GRACE_MS = 5_000;
interface ReclaimRefusal {
  readonly refused: true;
  readonly cause?: unknown;
}

const STAGED_NAME = /^\.lock-[0-9a-f-]{36}\.tmp$/;

/** The sibling staging file that shares the inode of the lock `path`, if there is one. */
async function stagedSibling(
  path: string,
  ino: number,
  dev: number,
): Promise<string | undefined> {
  const directory = dirname(path);
  for (const name of await readdir(directory)) {
    if (!STAGED_NAME.test(name)) continue;
    const candidate = join(directory, name);
    const info = await lstat(candidate).catch(() => undefined);
    if (info?.isFile() && info.ino === ino && info.dev === dev) return candidate;
  }
  return undefined;
}

async function readLockFile(
  path: string,
  onFailure?: (cause: unknown) => void,
  signal?: AbortSignal,
): Promise<LockFileState | undefined> {
  try {
    let stagedName: string | undefined;
    let record: Awaited<ReturnType<typeof readLockRecord>>;
    try {
      record = await readLockRecord(path, { signal });
    } catch (cause) {
      // A lock with exactly two names is safe to read only when the other name is its own
      // staging file; any other second link keeps the single-link refusal.
      if (!(cause instanceof LockRecordError) || cause.code !== 'LOCK_UNSAFE_RECORD')
        throw cause;
      const info = await lstat(path);
      stagedName =
        info.nlink === 2 ? await stagedSibling(path, info.ino, info.dev) : undefined;
      if (stagedName === undefined) throw cause;
      record = await readLockRecord(path, { signal, singleLink: false });
    }
    return {
      ...readOwner(record.text),
      ino: record.info.ino,
      dev: record.info.dev,
      mtimeMs: record.info.mtimeMs,
      ...(stagedName !== undefined && { stagedName }),
    };
  } catch (cause) {
    if (!isCode(cause, 'ENOENT')) onFailure?.(cause);
    return undefined;
  }
}

/**
 * Remove staging files whose recorded owner is provably gone on this machine: a holder that
 * died after writing its record and before (or while) publishing it leaves one behind.
 */
async function sweepStagedLocks(
  directory: string,
  machine: string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  for (const name of await readdir(directory).catch(() => [])) {
    if (!STAGED_NAME.test(name)) continue;
    const candidate = join(directory, name);
    const state = await readLockFile(candidate, undefined, signal);
    if (!state?.owner) continue;
    if ((await diagnose(state.owner, machine)).liveness !== 'gone') continue;
    await unlinkIfSame(
      candidate,
      state.ino,
      state.dev,
      state.stagedName === undefined ? 1 : 2,
    );
  }
}

/** Remove `path` only while it is still the file that was read as `ino`, with `links` names. */
async function unlinkIfSame(path: string, ino: number, dev: number, links = 1): Promise<void> {
  try {
    const current = await lstat(path);
    if (
      current.ino !== ino ||
      current.dev !== dev ||
      !current.isFile() ||
      current.nlink !== links
    )
      return;
    await unlink(path);
  } catch (error) {
    if (!isCode(error, 'ENOENT')) throw error;
  }
}

/**
 * Create the lock file at `path` with its owner already recorded.
 *
 * The record is written to a sibling temporary file and published with a hard
 * link, so a reader that sees the name sees a complete record, and a holder that
 * stalls or dies before the link leaves no lock behind. `EEXIST` is the refusal.
 */
async function createOwned(
  path: string,
  options: ExclusiveLockAttemptOptions,
  reclaimed: boolean,
): Promise<HeldExclusiveLock> {
  const identity = await machineIdentity(options.machineIdentity);
  const instance = await readProcessInstance(process.pid);
  const owner: ExclusiveLockOwner = {
    pid: process.pid,
    process: instance,
    host: hostname(),
    acquiredAt: new Date().toISOString(),
    ...(identity !== null && { machine: identity }),
  };
  const ownedRecord = `${JSON.stringify(owner)}\n`;
  const staged = join(dirname(path), `.lock-${randomUUID()}.tmp`);
  const handle = await open(staged, 'wx', options.mode);
  let ino: number | undefined;
  let dev: number | undefined;
  let published = false;
  try {
    const info = await handle.stat();
    ino = info.ino;
    dev = info.dev;
    // The creator owns this descriptor; umask must not silently drop shared-reader rights.
    await handle.chmod(options.mode);
    await handle.writeFile(ownedRecord, 'utf8');
    try {
      await publishAtomicFile(staged, path, { replace: false, durability: 'file' });
      published = true;
    } catch (error) {
      // The link exists but the staged name could not be removed: the lock has two
      // names, so it is not a held lock. Take it down rather than hold it.
      published = error instanceof AtomicFilePublicationError;
      throw error;
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (published && ino !== undefined && dev !== undefined)
      await unlinkIfSame(path, ino, dev, 2).catch(() => undefined);
    await unlink(staged).catch(() => undefined);
    throw error;
  }
  const ownedInode = ino;
  const ownedDevice = dev;
  let released = false;
  return {
    path,
    owner,
    reclaimed,
    async assertHeld() {
      if (released) throw new LockRecordError('LOCK_RECORD_CHANGED', 'Lock is released');
      const record = await readLockRecord(path);
      const descriptor = await handle.stat();
      if (
        released ||
        !descriptor.isFile() ||
        descriptor.nlink !== 1 ||
        descriptor.ino !== ownedInode ||
        descriptor.dev !== ownedDevice ||
        record.info.ino !== ownedInode ||
        record.info.dev !== ownedDevice ||
        record.text !== ownedRecord
      ) {
        throw new LockRecordError('LOCK_RECORD_CHANGED', 'Held lock generation changed');
      }
    },
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
  return (
    state.ownerless && typeof graceMs === 'number' && Date.now() - state.mtimeMs >= graceMs
  );
}

/**
 * Take the reclaim guard, re-read the lock under it, and replace the lock only
 * if it is still the dead one. A refusal preserves its recovery cause.
 */
async function reclaimUnderGuard(
  path: string,
  options: ExclusiveLockAttemptOptions,
  depth: number,
): Promise<HeldExclusiveLock | ReclaimRefusal> {
  const guardPath = `${path}.reclaim`;
  if (depth >= MAX_RECLAIM_DEPTH)
    return {
      refused: true,
      cause: new Error(
        `Exclusive lock reclaim guard recovery depth exceeds ${MAX_RECLAIM_DEPTH}`,
      ),
    };
  // A stale guard requires the same serialized recovery as a stale lock.
  // Checking its inode and then unlinking without a guard leaves a syscall
  // race in which another reclaimer's newly created guard can be removed.
  let acquired: ExclusiveLockAttempt;
  try {
    acquired = await attemptExclusiveLock(
      guardPath,
      {
        ...options,
        ownerlessGraceMs:
          options.ownerlessGraceMs === undefined
            ? STALE_GUARD_GRACE_MS
            : options.ownerlessGraceMs,
      },
      depth + 1,
    );
  } catch (cause) {
    // Only a generated guard's name refusal belongs to recovery diagnosis.
    // IO refusal for the caller's original path retains its ordinary native error.
    if (!isCode(cause, 'ENAMETOOLONG')) throw cause;
    return { refused: true, cause };
  }
  if (!('held' in acquired))
    return { refused: true, cause: acquired.diagnosis?.cause ?? acquired.error };
  const guard = acquired.held;
  try {
    // Re-read under the guard: the lock seen before it may have been reclaimed
    // and re-taken by the previous guard holder, and that one is alive.
    let readFailure: unknown;
    const state = await readLockFile(
      path,
      (cause) => {
        readFailure = cause;
      },
      options.signal,
    );
    if (readFailure !== undefined) return { refused: true, cause: readFailure };
    if (state) {
      const diagnosis = await diagnose(state.owner, options.machineIdentity);
      if (options.signal?.aborted) return { refused: true };
      if (!reclaimable(state, diagnosis, options.ownerlessGraceMs))
        return { refused: true, cause: diagnosis.cause };
      if (state.stagedName !== undefined)
        await unlink(state.stagedName).catch((error: unknown) => {
          if (!isCode(error, 'ENOENT')) throw error;
        });
      await unlinkIfSame(path, state.ino, state.dev);
    }
    await sweepStagedLocks(dirname(path), options.machineIdentity, options.signal);
    // An ordinary acquirer never unlinks, but it may create the file between
    // that unlink and this create; it then holds the lock, and this refuses.
    return await createOwned(path, options, state !== undefined).catch((error: unknown) => {
      if (isCode(error, 'EEXIST')) return { refused: true, cause: error };
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
  depth = 0,
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
    const reclaimed = await reclaimUnderGuard(path, options, depth);
    if (!('refused' in reclaimed)) return { held: reclaimed };
    return {
      error,
      diagnosis: {
        ...diagnosis,
        ...(reclaimed.cause !== undefined && { cause: reclaimed.cause }),
      },
    };
  }
}

/** Read the owner a present lock records, for a refusal that has to name it. */
export async function readExclusiveLockOwner(
  path: string,
): Promise<ExclusiveLockOwner | null> {
  return (await readLockFile(path))?.owner ?? null;
}
