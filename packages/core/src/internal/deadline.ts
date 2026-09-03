/**
 * Resolve to `{ settled: false }` if the value has not settled in time.
 *
 * One implementation, because two places need exactly this and they need it to
 * behave identically: an event bus asking listeners to vote, and a decision
 * pipeline asking policies to. A second copy would be a second set of bugs.
 *
 * The timer is always cleared: a dispatch must not be the reason a process stays
 * alive, and an uncleared timer on every announcement is exactly that.
 */
export async function withDeadline(
  value: unknown,
  timeoutMs: number,
): Promise<{ settled: true; value: unknown } | { settled: false }> {
  if (!(value instanceof Promise)) return { settled: true, value };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<{ settled: false }>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), timeoutMs);
  });
  try {
    return await Promise.race([
      value.then((settledValue) => ({ settled: true as const, value: settledValue })),
      expiry,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
