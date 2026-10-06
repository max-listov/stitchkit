import type { NativeCommandSettlement } from './contract';
import { commandCleanupError, waitForCommandClose } from './group';
import type { NativeCommandTransport } from './transport';

/**
 * One failure barrier, including a child whose transport setup never completed.
 *
 * The pipes close only after the stop sequence: a leader given a grace to exit keeps its
 * output open through it, and a write there does not meet a broken pipe.
 */
export async function cleanupNativeCommand(input: {
  error: unknown;
  transport?: NativeCommandTransport;
  settle: (event: NativeCommandSettlement) => Promise<void>;
  event?: NativeCommandSettlement;
  signal: () => Promise<unknown>;
  timeoutMs: number;
}): Promise<void> {
  const signalled = Promise.resolve().then(input.signal);
  const teardown = () => input.transport?.destroy();
  const destroyed = signalled.then(teardown, teardown);
  const awaitRelease = async () => {
    if (!input.transport) return;
    try {
      await waitForCommandClose(input.transport.released, input.timeoutMs);
    } catch (cause) {
      throw new Error(
        `Command handles remained open: ${[...input.transport.pendingHandles].join(', ')}`,
        { cause },
      );
    }
  };
  // A refused stop is reported once, by `signalled`; the handles are awaited only after a stop.
  const released = signalled.then(awaitRelease, () => undefined);
  const cleanup = await Promise.allSettled([
    input.settle(input.event ?? { kind: 'error', cause: input.error }),
    destroyed,
    signalled,
    released,
  ]);
  const failures = cleanup.flatMap((item) =>
    item.status === 'rejected' && item.reason !== input.error ? [item.reason] : [],
  );
  if (failures.length)
    throw commandCleanupError(
      new AggregateError([input.error, ...failures], 'Command failed and cleanup failed'),
    );
}
