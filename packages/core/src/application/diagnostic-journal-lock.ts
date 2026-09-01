import { constants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { isRecord } from '../internal/typed';
import type { DiagnosticJournalLockPolicy } from './diagnostic-journal-contract';

type FileHandle = Awaited<ReturnType<typeof open>>;

export interface AcquiredDiagnosticJournalLock {
  readonly handle: FileHandle;
  readonly reclaimedStale: boolean;
}

interface JournalLockOwner {
  readonly pid: number;
  readonly host: string;
  readonly acquiredAt: string;
}

function isExisting(error: unknown): boolean {
  return isRecord(error) && error.code === 'EEXIST';
}

function readOwner(text: string): JournalLockOwner | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const { pid, host, acquiredAt } = parsed;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (typeof host !== 'string' || host.length === 0) return undefined;
  if (typeof acquiredAt !== 'string') return undefined;
  return { pid, host, acquiredAt };
}

/**
 * Whether the recorded owner is provably gone.
 *
 * `kill(pid, 0)` delivers no signal and reports reachability: `ESRCH` is the only answer that
 * proves absence. `EPERM` means the process exists under another user, which is presence, and
 * every other outcome is unknown — both refuse. PID reuse can only turn a dead owner into a live
 * one, so the residual risk of this check is a refusal to reclaim, never a reclaim over a live
 * writer.
 */
function isGone(owner: JournalLockOwner): boolean {
  if (owner.host !== hostname()) return false; // another machine's process is not ours to probe
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return isRecord(error) && error.code === 'ESRCH';
  }
}

async function readLockOwner(lockPath: string): Promise<JournalLockOwner | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    return readOwner(await handle.readFile('utf8'));
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function createExclusive(lockPath: string, mode: number): Promise<FileHandle> {
  const handle = await open(lockPath, 'wx', mode);
  const owner: JournalLockOwner = {
    pid: process.pid,
    host: hostname(),
    acquiredAt: new Date().toISOString(),
  };
  await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
  return handle;
}

/**
 * Take the journal's exclusive lock under the configured policy.
 *
 * `refuse` is the default and rethrows the `EEXIST` a present lock produces. `reclaim-stale`
 * rethrows that same error unless the recorded owner is provably gone, so it is a strict superset
 * of `refuse`: every refusal a caller sees today it still sees, with the identical error.
 */
export async function acquireDiagnosticJournalLock(
  lockPath: string,
  mode: number,
  policy: DiagnosticJournalLockPolicy,
): Promise<AcquiredDiagnosticJournalLock> {
  try {
    return { handle: await createExclusive(lockPath, mode), reclaimedStale: false };
  } catch (error) {
    if (policy !== 'reclaim-stale' || !isExisting(error)) throw error;

    const owner = await readLockOwner(lockPath);
    // An unreadable or ownerless lock proves nothing. It predates this policy, or a writer died
    // between creating the file and recording itself; either way absence is not established.
    if (!owner || !isGone(owner)) throw error;

    await unlink(lockPath).catch(() => undefined);
    // If another reclaimer won the race between that unlink and this create, this one throws
    // `EEXIST` again and refuses exactly as it would have without the policy. One of us holds a
    // valid lock either way, which is the property that matters.
    return { handle: await createExclusive(lockPath, mode), reclaimedStale: true };
  }
}
