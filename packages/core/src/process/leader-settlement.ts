import { raceAbort } from '../internal/abort-race';
import type { NativeCommandSettlement, ParsedNativeCommandOptions } from './contract';
import { commandCleanupError } from './group';

/** One bounded external resource settlement, shared by observed exit and terminal failure. */
export function createLeaderSettlement(
  options: ParsedNativeCommandOptions,
  signal: AbortSignal,
) {
  let pending: Promise<void> | undefined;
  return (event: NativeCommandSettlement): Promise<void> => {
    if (pending) return pending;
    pending = (async () => {
      if (!options.onLeaderSettled) return;
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error('Leader settlement deadline exceeded')),
        options.cleanupTimeoutMs,
      );
      const abort = () => controller.abort(signal.reason);
      // A terminal failure still invokes cleanup once; cancellation during a running hook interrupts it.
      if (!signal.aborted) signal.addEventListener('abort', abort, { once: true });
      try {
        await raceAbort(
          Promise.resolve(options.onLeaderSettled(event, controller.signal)),
          controller.signal,
        );
      } catch (cause) {
        if (signal.aborted && cause === signal.reason) throw cause;
        throw commandCleanupError(
          new AggregateError([event, cause], 'Leader settlement failed'),
        );
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        controller.abort(new Error('Leader settlement completed'));
      }
    })();
    void pending.catch(() => undefined);
    return pending;
  };
}
