import type { NativeCommandSettlement } from './contract';
import { commandCleanupError, waitForCommandClose } from './group';
import type { NativeCommandTransport } from './transport';

/** One failure barrier, including a child whose transport setup never completed. */
export async function cleanupNativeCommand(input: {
  error: unknown;
  transport?: NativeCommandTransport;
  settle: (event: NativeCommandSettlement) => Promise<void>;
  event?: NativeCommandSettlement;
  signal: () => Promise<void>;
  timeoutMs: number;
}): Promise<void> {
  const cleanup = await Promise.allSettled([
    input.settle(input.event ?? { kind: 'error', cause: input.error }),
    Promise.resolve().then(() => input.transport?.destroy()),
    Promise.resolve()
      .then(input.signal)
      .then(async () => {
        if (!input.transport) return;
        try {
          await waitForCommandClose(input.transport.released, input.timeoutMs);
        } catch (cause) {
          throw new Error(
            `Command handles remained open: ${[...input.transport.pendingHandles].join(', ')}`,
            { cause },
          );
        }
      }),
  ]);
  const failures = cleanup.flatMap((item) =>
    item.status === 'rejected' && item.reason !== input.error ? [item.reason] : [],
  );
  if (failures.length)
    throw commandCleanupError(
      new AggregateError([input.error, ...failures], 'Command failed and cleanup failed'),
    );
}
