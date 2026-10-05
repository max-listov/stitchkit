/**
 * Run `run` with a handle that is closed afterwards on every path. A failure of
 * `run` is the one reported; a close failure is reported only when `run`
 * succeeded, because the first cause is the one a caller can act on.
 */
export async function closeAfter<T>(
  handle: { close(): Promise<void> },
  run: () => Promise<T>,
): Promise<T> {
  let result: T;
  try {
    result = await run();
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  await handle.close();
  return result;
}

/** The synchronous form of {@link closeAfter}, with the same error order. */
export function closeAfterSync<T>(close: () => void, run: () => T): T {
  let result: T;
  try {
    result = run();
  } catch (error) {
    try {
      close();
    } catch {
      // The failure of `run` is the report; a close failure after it adds nothing actionable.
    }
    throw error;
  }
  close();
  return result;
}
