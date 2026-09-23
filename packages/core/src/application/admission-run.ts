/**
 * An operation run under one admission lease, waited for within a deadline and
 * a caller's signal. The lease is released when the WORK settles, not when the
 * caller stops waiting: an abandoned wait never frees capacity the work holds.
 */
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
  if (options.timeoutMs !== undefined) {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0) {
      throw new TypeError('run timeoutMs must be a non-negative safe integer');
    }
  }
  if (options.signal?.aborted) throw new BoundedOperationWaitError('cancelled');
  const admission = acquire(key);
  if (admission.outcome === 'refused') {
    throw new BoundedAdmissionRefusalError(admission.reason, admission.retryAfterMs);
  }

  const workAbort = new AbortController();
  const abortWork = (): void => workAbort.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abortWork, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  if (options.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      workAbort.abort(new DOMException('Operation wait timed out', 'TimeoutError'));
    }, options.timeoutMs);
  }

  const outcome = Promise.resolve()
    .then(() => work({ signal: workAbort.signal }))
    .then(
      (value) => ({ kind: 'value' as const, value }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    )
    .finally(() => admission.lease.release());
  const callerDone = new Promise<{ kind: 'caller' }>((resolve) => {
    const settle = (): void => resolve({ kind: 'caller' });
    if (workAbort.signal.aborted) settle();
    else workAbort.signal.addEventListener('abort', settle, { once: true });
  });

  try {
    const settled = await Promise.race([outcome, callerDone]);
    if (settled.kind === 'caller') {
      throw new BoundedOperationWaitError(timedOut ? 'timed-out' : 'cancelled');
    }
    if (settled.kind === 'error') throw settled.error;
    return settled.value;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener('abort', abortWork);
  }
}
