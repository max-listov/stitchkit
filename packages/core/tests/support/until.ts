/** Polls an observable condition on the event loop (no timers) and fails with `what` after `budgetMs`. */
export async function until(
  condition: () => boolean | Promise<boolean>,
  what: string,
  budgetMs = 5_000,
): Promise<void> {
  const started = performance.now();
  while (!(await condition())) {
    if (performance.now() - started > budgetMs)
      throw new Error(`Timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** One turn of the event loop: queued I/O callbacks and microtasks have run once more. */
export function eventLoopTurn(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** Polls `read` on the event loop until it yields a value, which it returns; fails with `what` after `budgetMs`. */
export async function observe<T>(
  read: () => T | undefined | Promise<T | undefined>,
  what: string,
  budgetMs = 5_000,
): Promise<T> {
  const started = performance.now();
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (performance.now() - started > budgetMs)
      throw new Error(`Timed out waiting for ${what}`);
    await eventLoopTurn();
  }
}
