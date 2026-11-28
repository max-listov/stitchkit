import { linkAbortSignals } from '../internal/abort-race';
import type {
  AgentModelDriver,
  AgentModelDriverDecorator,
  AgentModelDriverStreamOutcome,
  AgentModelRequest,
  AgentModelStream,
  AgentModelStreamPart,
} from './models-driver';
import { AgentProviderStreamCutError } from './provider-failure';

function buildFinishedOutcome(
  part: Extract<AgentModelStreamPart, { type: 'finish' }>,
  sawErrorPart: boolean,
  lastErrorPart: unknown,
): Extract<AgentModelDriverStreamOutcome, { status: 'finished' }> {
  return {
    status: 'finished',
    finishReason: part.finishReason,
    usage: part.usage,
    ...(part.rawFinishReason !== undefined && { rawFinishReason: part.rawFinishReason }),
    ...(part.costDetails !== undefined && { costDetails: part.costDetails }),
    ...(part.responseProvider !== undefined && { responseProvider: part.responseProvider }),
    ...(part.response !== undefined && { response: part.response }),
    ...(sawErrorPart && lastErrorPart !== undefined && { error: lastErrorPart }),
  };
}

async function runDecoratedStream<TState>(
  driver: AgentModelDriver,
  decorator: AgentModelDriverDecorator<TState>,
  request: AgentModelRequest,
  signal: AbortSignal,
  state: TState,
): Promise<AgentModelStream> {
  let closePromise: Promise<void> | undefined;
  let iterating = false;
  let terminalOutcome: AgentModelDriverStreamOutcome | undefined;
  let sawErrorPart = false;
  let lastErrorPart: unknown;
  let effectiveLink: { signal: AbortSignal; release(): void } | undefined;
  let effectiveSignal: AbortSignal = signal;

  const onAbort = (): void => {
    if (iterating) return;
    void closeOnce(terminalOutcome ?? { status: 'cancelled' }).catch(() => undefined);
  };
  const closeOnce = (outcome: AgentModelDriverStreamOutcome): Promise<void> => {
    if (!closePromise) {
      signal.removeEventListener('abort', onAbort);
      effectiveSignal.removeEventListener('abort', onAbort);
      effectiveLink?.release();
      effectiveLink = undefined;
      closePromise = Promise.resolve().then(() => decorator.onClose?.(outcome, state));
    }
    return closePromise;
  };

  if (signal.aborted) {
    await closeOnce({ status: 'cancelled' });
    signal.throwIfAborted();
  }

  let inner: AgentModelStream;
  try {
    const effectiveRequest = decorator.transformRequest
      ? await decorator.transformRequest(request, state)
      : request;
    if (decorator.transformSignal) {
      const tightened = decorator.transformSignal(signal, state);
      if (tightened !== undefined && tightened !== signal) {
        effectiveLink = linkAbortSignals(signal, tightened);
        effectiveSignal = effectiveLink.signal;
      }
    }
    if (effectiveSignal.aborted) {
      await closeOnce({ status: 'cancelled' });
      effectiveSignal.throwIfAborted();
    }
    inner = await driver.stream(effectiveRequest, effectiveSignal);
  } catch (error) {
    await closeOnce(
      effectiveSignal.aborted ? { status: 'cancelled' } : { status: 'errored', error },
    );
    throw error;
  }

  // Register after inner.stream() resolves so un-iterated aborts unwind inner -> outer (LIFO).
  if (effectiveSignal.aborted) {
    void closeOnce({ status: 'cancelled' }).catch(() => undefined);
  } else {
    effectiveSignal.addEventListener('abort', onAbort, { once: true });
  }

  const parts: AsyncIterable<AgentModelStreamPart> = {
    [Symbol.asyncIterator]() {
      iterating = true;
      effectiveSignal.removeEventListener('abort', onAbort);
      let iterator: AsyncIterator<AgentModelStreamPart>;
      try {
        iterator = inner.parts[Symbol.asyncIterator]();
      } catch (error) {
        void closeOnce(
          effectiveSignal.aborted ? { status: 'cancelled' } : { status: 'errored', error },
        ).catch(() => undefined);
        throw error;
      }

      const closeOnDone = (): Promise<void> => {
        if (terminalOutcome !== undefined) return closeOnce(terminalOutcome);
        if (sawErrorPart) return closeOnce({ status: 'errored', error: lastErrorPart });
        if (effectiveSignal.aborted) return closeOnce({ status: 'cancelled' });
        return closeOnce({
          status: 'errored',
          error: new AgentProviderStreamCutError(
            'Provider stream ended before a finish part',
            {
              provider: driver.provider,
            },
          ),
        });
      };

      return {
        async next() {
          let next: IteratorResult<AgentModelStreamPart>;
          try {
            next = await iterator.next();
          } catch (error) {
            await closeOnce(
              terminalOutcome ??
                (effectiveSignal.aborted
                  ? { status: 'cancelled' }
                  : { status: 'errored', error }),
            );
            throw error;
          }
          if (next.done) {
            await closeOnDone();
            return next;
          }
          const part = next.value;
          try {
            await decorator.onPart?.(part, state);
          } catch (error) {
            try {
              await iterator.return?.();
            } catch {
              // Secondary cleanup failure must not mask the decorator error or skip onClose.
            }
            await closeOnce({ status: 'errored', error });
            throw error;
          }
          if (part.type === 'finish') {
            terminalOutcome = buildFinishedOutcome(part, sawErrorPart, lastErrorPart);
          } else if (part.type === 'error') {
            sawErrorPart = true;
            lastErrorPart = part.error;
          }
          return next;
        },
        async return(value?: unknown) {
          try {
            if (iterator.return) await iterator.return(value);
          } finally {
            await closeOnce(
              terminalOutcome ??
                (sawErrorPart
                  ? { status: 'errored', error: lastErrorPart }
                  : { status: 'cancelled' }),
            );
          }
          return { done: true as const, value: undefined };
        },
        async throw(error?: unknown) {
          try {
            if (iterator.throw) return await iterator.throw(error);
            throw error;
          } finally {
            await closeOnce(
              terminalOutcome ??
                (effectiveSignal.aborted
                  ? { status: 'cancelled' }
                  : { status: 'errored', error }),
            );
          }
        },
      };
    },
  };

  return {
    ...(inner.response !== undefined && { response: inner.response }),
    parts,
  };
}

/**
 * Wrap one `AgentModelDriver` with a lifecycle decorator whose `onClose` is guaranteed
 * to run exactly once on finish, throw, early stream cancellation, or abort. → ADR 0336.
 */
export function wrapModelDriver<TState>(
  driver: AgentModelDriver,
  decorator: AgentModelDriverDecorator<TState> & {
    beforeStream(
      request: AgentModelRequest,
      signal: AbortSignal,
      context: { readonly provider: string; readonly modelId: string },
    ): TState | Promise<TState>;
  },
): AgentModelDriver;
export function wrapModelDriver(
  driver: AgentModelDriver,
  decorator: AgentModelDriverDecorator<undefined>,
): AgentModelDriver;
export function wrapModelDriver<TState = unknown>(
  driver: AgentModelDriver,
  decorator: AgentModelDriverDecorator<TState>,
): AgentModelDriver;
export function wrapModelDriver(
  driver: AgentModelDriver,
  decorator: AgentModelDriverDecorator<unknown>,
): AgentModelDriver {
  return {
    provider: driver.provider,
    modelId: driver.modelId,
    async stream(request, signal) {
      const state = decorator.beforeStream
        ? await decorator.beforeStream(request, signal, {
            provider: driver.provider,
            modelId: driver.modelId,
          })
        : undefined;
      return runDecoratedStream(driver, decorator, request, signal, state);
    },
  };
}

/**
 * Compose an ordered list of decorators around one `AgentModelDriver` in outer-to-inner
 * middleware order (`decorators[0]` runs `beforeStream` first and `onClose` last).
 */
export function composeModelDrivers<const TStates extends readonly unknown[]>(
  driver: AgentModelDriver,
  decorators: { readonly [K in keyof TStates]: AgentModelDriverDecorator<TStates[K]> },
): AgentModelDriver {
  let current = driver;
  for (let index = decorators.length - 1; index >= 0; index -= 1) {
    const decorator = decorators[index];
    if (decorator !== undefined) {
      current = wrapModelDriver(current, decorator);
    }
  }
  return current;
}
