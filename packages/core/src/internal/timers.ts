/** The longest delay a timer can wait (2^31 - 1 ms, about 24.8 days); a longer one fires at once. */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * Wait `ms`, or reject with the signal's reason as soon as `signal` aborts.
 *
 * One abortable pause for every retry, backoff and poll loop. The timer is cleared
 * on abort and the listener is removed on completion, so a cancelled wait leaves
 * nothing behind.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
