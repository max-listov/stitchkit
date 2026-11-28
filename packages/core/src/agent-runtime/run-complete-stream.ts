import { abortReason, linkAbortSignals } from '../internal/abort-race';
import type { AgentToolSet } from '../tools/agent-tools';
import type {
  CompleteStreamPart,
  CompleteTextInput,
  CompleteTextResult,
  CompleteTextStream,
} from './run-complete-types';

/** Bounded backpressure buffer limit for `streamComplete().parts` (I10). */
const STREAM_COMPLETE_BUFFER_LIMIT = 64;

/**
 * Drop only queued chunks belonging to the current discarded attempt while retaining
 * any already-completed prior-step events (up to and including the last `finish-step`).
 */
function discardUncommittedQueueParts(queue: CompleteStreamPart[]): boolean {
  let keepCount = 0;
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    if (queue[index]?.type === 'finish-step') {
      keepCount = index + 1;
      break;
    }
  }
  if (queue.length <= keepCount) return false;
  queue.length = keepCount;
  return true;
}

/**
 * Park one producer on the FIFO backpressure queue while listening to an optional
 * per-step or per-attempt `waitSignal`, ensuring neither `stepAbort` nor `idleDeadline`
 * can deadlock `pushWaiters` and no abort listener leaks once woken.
 */
function waitForQueueCapacity(
  pushWaiters: (() => void)[],
  waitSignal?: AbortSignal,
): Promise<void> {
  if (waitSignal?.aborted) return Promise.reject(abortReason(waitSignal));
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const onQueueWake = (): void => {
      if (settled) return;
      settled = true;
      if (waitSignal) waitSignal.removeEventListener('abort', onSignalAbort);
      resolve();
    };
    const onSignalAbort = (): void => {
      if (settled) return;
      settled = true;
      const index = pushWaiters.indexOf(onQueueWake);
      if (index >= 0) pushWaiters.splice(index, 1);
      reject(waitSignal ? abortReason(waitSignal) : undefined);
    };
    pushWaiters.push(onQueueWake);
    if (waitSignal) {
      waitSignal.addEventListener('abort', onSignalAbort, { once: true });
    }
  });
}

/**
 * Bounded single-consumer async stream adapter over `runCompleteLoop` with FIFO
 * multi-producer backpressure, abort wakeups without listener leaks, and in-band
 * retry buffer resets.
 */
export function createCompleteTextStream<TOOLS extends AgentToolSet>(
  input: CompleteTextInput<TOOLS>,
  runLoop: (
    loopInput: CompleteTextInput<TOOLS>,
    emitPart: (part: CompleteStreamPart, waitSignal?: AbortSignal) => Promise<void>,
    effectiveSignal: AbortSignal,
  ) => Promise<CompleteTextResult>,
): CompleteTextStream {
  const streamAbort = new AbortController();
  const link = linkAbortSignals(input.signal, streamAbort.signal);
  const queue: CompleteStreamPart[] = [];
  const pushWaiters: (() => void)[] = [];
  let done = false;
  let failure: unknown;
  let hasFailure = false;
  let consumerClosed = false;
  let startedIterating = false;
  let pullWaiter: (() => void) | undefined;

  const wakePull = (): void => {
    const resolve = pullWaiter;
    pullWaiter = undefined;
    resolve?.();
  };
  const wakeOnePush = (): void => {
    pushWaiters.shift()?.();
  };
  const wakeAllPush = (): void => {
    while (pushWaiters.length > 0) {
      pushWaiters.shift()?.();
    }
  };

  const onAbort = (): void => {
    queue.length = 0;
    wakeAllPush();
    wakePull();
  };
  if (!link.signal.aborted) {
    link.signal.addEventListener('abort', onAbort, { once: true });
  }

  const emitPart = async (
    part: CompleteStreamPart,
    waitSignal?: AbortSignal,
  ): Promise<void> => {
    if (consumerClosed || link.signal.aborted) return;
    if (waitSignal?.aborted) throw abortReason(waitSignal);
    try {
      await input.onPart?.(part);
    } catch (error) {
      if (!streamAbort.signal.aborted) streamAbort.abort(error);
      throw error;
    }
    if (consumerClosed || link.signal.aborted) return;
    if (waitSignal?.aborted) throw abortReason(waitSignal);
    while (
      queue.length >= STREAM_COMPLETE_BUFFER_LIMIT &&
      !consumerClosed &&
      !link.signal.aborted &&
      !waitSignal?.aborted
    ) {
      await waitForQueueCapacity(pushWaiters, waitSignal);
    }
    if (consumerClosed || link.signal.aborted) return;
    if (waitSignal?.aborted) throw abortReason(waitSignal);
    queue.push(part);
    wakePull();
  };

  const wrappedInput: CompleteTextInput<TOOLS> = {
    ...input,
    onAttemptDiscarded: async (info) => {
      if (discardUncommittedQueueParts(queue)) wakeAllPush();
      await input.onAttemptDiscarded?.(info);
    },
  };

  const cleanupSignal = (): void => {
    link.signal.removeEventListener('abort', onAbort);
    link.release();
  };

  const result = runLoop(wrappedInput, emitPart, link.signal).then(
    (res) => {
      done = true;
      cleanupSignal();
      wakeAllPush();
      wakePull();
      return res;
    },
    (error: unknown) => {
      done = true;
      hasFailure = true;
      failure = error;
      cleanupSignal();
      wakeAllPush();
      wakePull();
      throw error;
    },
  );
  // Prevent unhandled rejection when caller consumes errors solely via `for await (parts)`.
  void result.catch(() => undefined);

  const parts: AsyncIterable<CompleteStreamPart> = {
    [Symbol.asyncIterator]() {
      if (startedIterating) {
        throw new TypeError('streamComplete().parts can only be iterated once');
      }
      startedIterating = true;
      return {
        async next(): Promise<IteratorResult<CompleteStreamPart>> {
          for (;;) {
            if (queue.length > 0) {
              const value = queue.shift();
              wakeOnePush();
              if (value !== undefined) return { done: false, value };
            }
            if (done) {
              if (hasFailure) throw failure;
              return { done: true, value: undefined };
            }
            await new Promise<void>((resolve) => {
              pullWaiter = resolve;
            });
          }
        },
        async return(): Promise<IteratorResult<CompleteStreamPart>> {
          consumerClosed = true;
          queue.length = 0;
          streamAbort.abort(new Error('streamComplete consumer closed stream'));
          wakeAllPush();
          wakePull();
          await result.catch(() => undefined);
          return { done: true, value: undefined };
        },
      };
    },
  };

  return { parts, result };
}
