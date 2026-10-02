import { raceAbort } from '../internal/abort-race';
import type { NativeCommandSettlement, ParsedNativeCommandOptions } from './contract';
import { commandCleanupError, createCommandDeadline } from './group';

/** An internal caller may bound drain/close after leader settlement without changing generic drain. */
export function createLeaderCloseDeadline(
  leader: Promise<NativeCommandSettlement>,
  timeoutMs: number | undefined,
  controller: AbortController,
) {
  let finished = false;
  let deadline: ReturnType<typeof createCommandDeadline> | undefined;
  const expired = () => controller.abort(deadline?.signal.reason);
  if (timeoutMs !== undefined)
    void leader.then(() => {
      if (finished) return;
      deadline = createCommandDeadline(
        timeoutMs,
        commandCleanupError(new Error('Command close deadline exceeded after leader exit')),
      );
      deadline.signal.addEventListener('abort', expired, { once: true });
    });
  return () => {
    finished = true;
    deadline?.cancel();
    deadline?.signal.removeEventListener('abort', expired);
  };
}

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
      const deadline = createCommandDeadline(
        options.cleanupTimeoutMs,
        new Error('Leader settlement deadline exceeded'),
      );
      const expired = () => controller.abort(deadline.signal.reason);
      if (deadline.signal.aborted) expired();
      else deadline.signal.addEventListener('abort', expired, { once: true });
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
        deadline.cancel();
        deadline.signal.removeEventListener('abort', expired);
        signal.removeEventListener('abort', abort);
        controller.abort(new Error('Leader settlement completed'));
      }
    })();
    void pending.catch(() => undefined);
    return pending;
  };
}
