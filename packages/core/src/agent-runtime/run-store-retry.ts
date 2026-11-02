/**
 * The pauses of one store call that decides whether a run's record ends active:
 * about half a second each, during which the conversation's lane stays held.
 * A store that stays down longer is the host's to handle. These bound a call
 * that fails, not one that hangs: the store owns its own timeouts.
 */
const STORE_RETRY_DELAYS_MS = [25, 100, 400];

/** The pause before retry `failures`, or `undefined` once the budget is spent. */
export function storeRetryDelay(failures: number): number | undefined {
  return STORE_RETRY_DELAYS_MS[failures];
}

/**
 * Run one store call, again on a thrown failure. A conflict is an outcome the
 * store returns, not one it throws, so a retry here never repeats its answer.
 */
export async function withStoreRetries<RESULT>(work: () => Promise<RESULT>): Promise<RESULT> {
  for (let failures = 0; ; failures += 1) {
    try {
      return await work();
    } catch (error) {
      const delay = storeRetryDelay(failures);
      if (delay === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
