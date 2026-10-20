/**
 * Who holds an exclusive lock, as its file records it, and whether that holder is provably gone.
 *
 * The verdict is conservative in one direction only: an unknown machine, an unprobed process or an
 * unreadable descriptor table is "not gone", so the residual error is a refusal to reclaim, never
 * a second holder.
 */
import { hostname } from 'node:os';
import { z } from 'zod';
import { type FileIdentity, holdsOpenDescriptor } from './open-descriptors';
import { machineIdentity } from './process-identity';
import {
  ProcessInstanceSchema,
  type ProcessOwnerEvidence,
  probeProcessOwner,
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

/** Why a present lock was or was not taken. */
export interface ExclusiveLockDiagnosis {
  readonly attribution: 'this-machine' | 'another-machine' | 'unattributable';
  readonly liveness: 'alive' | 'gone' | 'not-probed';
  /**
   * The process evidence, plus `descriptor-closed`: the record names this very process, and no
   * descriptor of this process is open on the lock — an earlier image of the PID left it.
   */
  readonly identity?: ProcessOwnerEvidence['identity'] | 'descriptor-closed';
  readonly owner: ExclusiveLockOwner | null;
  readonly cause?: unknown;
}

export function readOwner(text: string): {
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
 * different states, and collapsing them is a permanent silent refusal.
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

/** A lock file as read: its recorded owner, if readable, and the file it was read from. */
export interface RecordedLock extends FileIdentity {
  readonly path: string;
  readonly owner: ExclusiveLockOwner | undefined;
}

/**
 * Judge the recorded owner of a lock file that was read, or of none when it was not.
 *
 * A record that names this process with matching kernel identity is held only while a descriptor
 * of this process is open on the file: a holder keeps the descriptor it created the lock with
 * until it releases, in every version that records a process identity. A process image replaced
 * in place keeps its PID and start time but not that descriptor, so the lock it left is gone —
 * judged alive, it would stay held until the PID changed.
 */
export async function diagnose(
  lock: RecordedLock | undefined,
  declaredIdentity: string | undefined,
): Promise<ExclusiveLockDiagnosis> {
  const owner = lock?.owner;
  if (!lock || !owner)
    return { attribution: 'unattributable', liveness: 'not-probed', owner: null };
  const attribution = attribute(owner, await machineIdentity(declaredIdentity));
  if (attribution !== 'this-machine') return { attribution, liveness: 'not-probed', owner };
  const evidence = await probeProcessOwner(owner.pid, owner.process);
  if (
    evidence.identity === 'matched' &&
    owner.pid === process.pid &&
    (await holdsOpenDescriptor(lock.path, lock)) === false
  )
    return { attribution, liveness: 'gone', identity: 'descriptor-closed', owner };
  return { attribution, ...evidence, owner };
}
