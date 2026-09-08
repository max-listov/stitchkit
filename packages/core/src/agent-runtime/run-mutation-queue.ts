/**
 * Owned mutations of one run, applied one at a time.
 *
 * Every owned mutation is a compare-and-set against the run's current revision,
 * and the revision it must name is the one the previous mutation produced.
 * Reading that revision and writing it back are therefore safe apart only while
 * nothing else can write in between — which stops being true the moment a store
 * returns a promise that yields. With an asynchronous store the assistant
 * checkpoint and the model-request admission both name the revision they read
 * before their own `await`, the later write is rejected as a conflict, and the
 * run fails without the provider ever having been called.
 *
 * The terminal commit answers the same hazard with a bounded retry, which suits
 * it: committing a terminal twice is a duplicate the store recognises. It does
 * not suit these two — a retried operation write would publish a second
 * lifecycle event for one provider call — so they take their turn instead.
 */
export type RunMutationQueue = <T>(mutation: () => Promise<T>) => Promise<T>;

/** A queue of owned mutations for one run. */
export function createRunMutationQueue(): RunMutationQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(mutation: () => Promise<T>): Promise<T> => {
    // `then` on both settlements: the queue advances past a rejected mutation
    // rather than inheriting its failure.
    const result = tail.then(mutation, mutation);
    // A failure belongs to the caller that queued it. Swallowing it here as
    // well keeps one rejected write from rejecting every write behind it —
    // and keeps the runtime from reporting an unhandled rejection for a
    // failure its own caller is already awaiting.
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
