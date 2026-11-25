/**
 * An operation run under one admission lease, waited for within a deadline and
 * a caller's signal. The lease is released when the WORK settles, not when the
 * caller stops waiting: an abandoned wait never frees capacity the work holds.
 */

import { abortError } from '../internal/abort-error';
import { linkAbortSignals } from '../internal/abort-race';
import { assertTimerMs } from '../internal/deadline';
import {
  BoundedAdmissionRefusalError,
  type BoundedAdmissionResult,
  type BoundedOperationRunContext,
  type BoundedOperationRunOptions,
  BoundedOperationWaitError,
} from './admission';

export async function runAdmitted<T>(
  acquire: (key?: string) => BoundedAdmissionResult,
  key: string | undefined,
  work: (context: BoundedOperationRunContext) => T | Promise<T>,
  options: BoundedOperationRunOptions,
): Promise<T> {
  assertTimerMs('run timeoutMs', options.timeoutMs, { min: 0 });
  if (options.signal?.aborted) throw new BoundedOperationWaitError('cancelled');
  const admission = acquire(key);
  if (admission.outcome === 'refused') {
    throw new BoundedAdmissionRefusalError(admission.reason, admission.retryAfterMs);
  }

  // The work's signal follows the caller and the deadline, until the wait ends.
  const deadline = new AbortController();
  const link = options.signal ? linkAbortSignals(options.signal, deadline.signal) : undefined;
  const workSignal = link?.signal ?? deadline.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (options.timeoutMs !== undefined) {
    timer = setTimeout(
      () => deadline.abort(abortError('Operation wait timed out', 'TimeoutError')),
      options.timeoutMs,
    );
  }

  const outcome = Promise.resolve()
    .then(() => work({ signal: workSignal }))
    .then(
      (value) => ({ kind: 'value' as const, value }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    )
    .finally(() => admission.lease.release());
  const callerDone = new Promise<{ kind: 'caller' }>((resolve) => {
    const settle = (): void => resolve({ kind: 'caller' });
    if (workSignal.aborted) settle();
    else workSignal.addEventListener('abort', settle, { once: true });
  });

  try {
    const settled = await Promise.race([outcome, callerDone]);
    if (settled.kind === 'caller') {
      throw new BoundedOperationWaitError(deadline.signal.aborted ? 'timed-out' : 'cancelled');
    }
    if (settled.kind === 'error') throw settled.error;
    return settled.value;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    link?.release();
  }
}
