/** FIFO mutations with caller-visible failures and an optional finite admission bound. */
export type MutationQueue = <T>(mutation: () => Promise<T>) => Promise<T>;

export function createMutationQueue(maxPending = Number.POSITIVE_INFINITY): MutationQueue {
  if (
    maxPending !== Number.POSITIVE_INFINITY &&
    (!Number.isInteger(maxPending) || maxPending < 1)
  ) {
    throw new RangeError('maxPending must be a positive integer');
  }
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;
  return <T>(mutation: () => Promise<T>): Promise<T> => {
    if (pending >= maxPending)
      return Promise.reject(new Error('Mutation queue capacity exceeded'));
    pending += 1;
    const result = tail.then(mutation, mutation);
    tail = result.then(
      () => {
        pending -= 1;
      },
      () => {
        pending -= 1;
      },
    );
    return result;
  };
}
