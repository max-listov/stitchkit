import { attemptExclusiveLock, type HeldExclusiveLock } from '../internal/exclusive-lock';
import type { DiagnosticJournalLockPolicy } from './diagnostic-journal-contract';

export interface AcquiredDiagnosticJournalLock {
  readonly lock: HeldExclusiveLock;
  readonly reclaimedStale: boolean;
}

/**
 * Take the journal's exclusive lock under the configured policy.
 *
 * The mechanism is the shared exclusive lock (`withExclusiveLock` in
 * `stitchkit/files`); what stays here is the journal's policy. `refuse` is the
 * default and rethrows the `EEXIST` a present lock produces. `reclaim-stale`
 * rethrows that same error unless the recorded owner is provably gone, so it is
 * a strict superset of `refuse`: every refusal a caller sees today it still
 * sees, with the identical error. Unlike the public lock the journal waits for
 * nothing and never takes an ownerless lock — one may predate owner records.
 *
 * A refusal under `reclaim-stale` carries its reason on that error, readable through
 * `readDiagnosticJournalLockDiagnosis`. It is attached rather than thrown so the error a caller
 * already handles does not change shape; the point is that "the owner is alive" and "this lock
 * cannot be attributed to this host" stop being the same silent answer. The consumer that met this
 * printed "another process is running against this state" — a sentence it had no evidence for.
 */
export async function acquireDiagnosticJournalLock(
  lockPath: string,
  mode: number,
  policy: DiagnosticJournalLockPolicy,
  declaredIdentity?: string,
): Promise<AcquiredDiagnosticJournalLock> {
  const attempt = await attemptExclusiveLock(lockPath, {
    mode,
    reclaim: policy === 'reclaim-stale',
    ...(declaredIdentity !== undefined && { machineIdentity: declaredIdentity }),
  });
  if ('held' in attempt) {
    return { lock: attempt.held, reclaimedStale: attempt.held.reclaimed };
  }
  const { error, diagnosis } = attempt;
  if (diagnosis && error !== null && typeof error === 'object') {
    Object.assign(error, { journalLock: diagnosis });
  }
  throw error;
}
