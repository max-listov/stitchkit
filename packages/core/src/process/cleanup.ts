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
  // The leader settles once its exit after the stop is observed, so the event carries what the
  // kernel reported; with no transport, or no exit within the bound, it is a bare `error`.
  const stopped = async (): Promise<NativeCommandSettlement> => {
    const failed: NativeCommandSettlement = { kind: 'error', cause: input.error };
    if (!input.transport) return failed;
    await signalled.catch(() => undefined);
    const leader = await waitForCommandClose(input.transport.leader, input.timeoutMs).catch(
      () => undefined,
    );
    return leader?.kind === 'exit'
      ? {
          kind: 'stopped',
          cause: input.error,
          exitCode: leader.exitCode,
          signal: leader.signal,
        }
      : failed;
  };
  const cleanup = await Promise.allSettled([
    input.event ? input.settle(input.event) : stopped().then(input.settle),
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
