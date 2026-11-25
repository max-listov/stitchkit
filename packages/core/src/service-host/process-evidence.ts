import { errnoOf } from '../internal/errno';
import type { ProcessOwnerEvidence } from '../internal/process-instance';

/** Failure classification produced when post-inspection process ownership no longer matches. */
export type ProcessOwnerVerificationFailure =
  | {
      status: 'runtime-conflict';
      reason: 'pid-reused';
      pid: number;
    }
  | {
      status: 'runtime-unavailable';
      reason: 'process-gone' | 'process-unobservable';
      pid: number;
      cause?: unknown;
    };

/** Return `true` when an errno signals that the target process or procfs entry no longer exists. */
export function isProcessGoneError(error: unknown): boolean {
  const code = errnoOf(error);
  return code === 'ENOENT' || code === 'ESRCH';
}

/** Map a `probeProcessOwner` result into a verification failure, or `null` when ownership still matches. */
export function classifyOwnerEvidence(
  pid: number,
  owner: ProcessOwnerEvidence,
): ProcessOwnerVerificationFailure | null {
  if (owner.identity === 'reused-pid' || owner.identity === 'different-boot') {
    return { status: 'runtime-conflict', reason: 'pid-reused', pid };
  }
  if (owner.identity === 'pid-gone' || owner.liveness === 'gone') {
    return { status: 'runtime-unavailable', reason: 'process-gone', pid };
  }
  if (owner.identity !== 'matched') {
    return {
      status: 'runtime-unavailable',
      reason: 'process-unobservable',
      pid,
      cause: owner.cause,
    };
  }
  return null;
}
