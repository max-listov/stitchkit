/**
 * Who holds an exclusive lock, as its file records it, and whether that holder is provably gone.
 *
 * The verdict is conservative in one direction only: an unknown machine, an unprobed process or an
 * unreadable descriptor table is "not gone", so the residual error is a refusal to reclaim, never
 * a second holder.
 *
 * Every lock file of this library is judged here: the asynchronous exclusive lock and the
 * synchronous unix socket startup lock write the same record and read it by the same rule. Each
 * step has a synchronous twin over the same evidence, for a caller that cannot wait.
 */
import { hostname } from 'node:os';
import { z } from 'zod';
import {
  type FileIdentity,
  holdsOpenDescriptor,
  holdsOpenDescriptorSync,
} from './open-descriptors';
import { machineIdentity, machineIdentitySync } from './process-identity';
import {
  type ProcessInstance,
  ProcessInstanceSchema,
  type ProcessOwnerEvidence,
  probeProcessOwner,
  probeProcessOwnerSync,
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

/**
 * The record a new holder writes: this process, its lifetime and this machine. A lifetime or a
 * machine the platform cannot name is recorded as unknown, which only ever refuses a reclaim.
 */
export function recordOwner(
  machine: string | null,
  instance: ProcessInstance | null,
): ExclusiveLockOwner {
  return {
    pid: process.pid,
    process: instance,
    host: hostname(),
    acquiredAt: new Date().toISOString(),
    ...(machine !== null && { machine }),
  };
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

const UNJUDGED: ExclusiveLockDiagnosis = {
  attribution: 'unattributable',
  liveness: 'not-probed',
  owner: null,
};

/**
 * A record that names this very process with matching kernel identity, which is the one case the
 * descriptor table decides.
 */
function namesThisProcess(owner: ExclusiveLockOwner, evidence: ProcessOwnerEvidence): boolean {
  return evidence.identity === 'matched' && owner.pid === process.pid;
}

function judged(
  attribution: ExclusiveLockDiagnosis['attribution'],
  evidence: ProcessOwnerEvidence,
  owner: ExclusiveLockOwner,
  heldHere: boolean | null,
): ExclusiveLockDiagnosis {
  if (heldHere === false)
    return { attribution, liveness: 'gone', identity: 'descriptor-closed', owner };
  return { attribution, ...evidence, owner };
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
  signal?: AbortSignal,
): Promise<ExclusiveLockDiagnosis> {
  const owner = lock?.owner;
  if (!lock || !owner) return UNJUDGED;
  const attribution = attribute(owner, await machineIdentity(declaredIdentity, signal));
  if (attribution !== 'this-machine') return { attribution, liveness: 'not-probed', owner };
  const evidence = await probeProcessOwner(owner.pid, owner.process);
  const heldHere = namesThisProcess(owner, evidence)
    ? await holdsOpenDescriptor(lock.path, lock)
    : null;
  return judged(attribution, evidence, owner, heldHere);
}

/** {@link diagnose} for a caller that cannot wait: the same steps on synchronous evidence. */
export function diagnoseSync(
  lock: RecordedLock | undefined,
  declaredIdentity: string | undefined,
): ExclusiveLockDiagnosis {
  const owner = lock?.owner;
  if (!lock || !owner) return UNJUDGED;
  const attribution = attribute(owner, machineIdentitySync(declaredIdentity));
  if (attribution !== 'this-machine') return { attribution, liveness: 'not-probed', owner };
  const evidence = probeProcessOwnerSync(owner.pid, owner.process);
  const heldHere = namesThisProcess(owner, evidence)
    ? holdsOpenDescriptorSync(lock.path, lock)
    : null;
  return judged(attribution, evidence, owner, heldHere);
}

/** What a judged lock file carries beyond its owner: whether it had one, and how old it is. */
export interface JudgedLockFile {
  readonly owner: ExclusiveLockOwner | undefined;
  readonly ownerless: boolean;
  readonly mtimeMs: number;
}

/**
 * Whether a present lock may be taken. An owner is taken only when it is provably gone; a file
 * with no readable owner at all — never produced here, but an older writer could leave one — only
 * when the caller opted in to an age and the file is at least that old.
 */
export function reclaimable(
  state: JudgedLockFile,
  diagnosis: ExclusiveLockDiagnosis,
  graceMs: number | null | undefined,
): boolean {
  if (state.owner) return diagnosis.liveness === 'gone';
  return (
    state.ownerless && typeof graceMs === 'number' && Date.now() - state.mtimeMs >= graceMs
  );
}
