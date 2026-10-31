/**
 * The outbound budget as a grammY client transformer.
 *
 * `budget.run` is the narrow adapter; wiring it by hand means writing the same
 * closure in every bot and deciding, again, what a cancelled wait is. This is
 * that closure once: `bot.api.config.use(telegramBudgetTransformer(budget))`.
 *
 * grammY types the signal it hands a transformer as the `abort-controller`
 * polyfill's, which is not the platform `AbortSignal` the budget waits on, so a
 * hand-written adapter either casts it or passes `undefined` and loses
 * cancellation. The transformer bridges it, and a wait that is cancelled before
 * the request was handed to the client is reported as what it is —
 * `TelegramNotDispatchedError`, safe to repeat — while a request cancelled in
 * flight stays the client's own error, because it may have arrived.
 *
 * grammY is named in the declarations and never imported at run time.
 */

import type { Transformer } from 'grammy';
import { TelegramNotDispatchedError } from './not-dispatched';
import type { TelegramOutboundBudget } from './outbound-budget';

interface PlatformSignal {
  readonly signal: AbortSignal | undefined;
  /** Detach from the caller's signal once the call has settled. */
  release(): void;
}

/**
 * The platform signal the budget needs, for a signal that may not be one. A
 * platform signal is used as it is, so its `reason` reaches the caller intact.
 */
function platformSignal(signal: Parameters<Transformer>[3]): PlatformSignal {
  if (signal === undefined) return { signal: undefined, release: () => undefined };
  if (signal instanceof AbortSignal) return { signal, release: () => undefined };
  const controller = new AbortController();
  const abort = (): void => {
    const reason: unknown = Reflect.get(signal, 'reason');
    controller.abort(reason ?? new DOMException('This operation was aborted', 'AbortError'));
  };
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort);
  return {
    signal: controller.signal,
    release: () => signal.removeEventListener('abort', abort),
  };
}

/**
 * A grammY client transformer that runs every Bot API call under `budget`.
 *
 * Install it as the bot's one transformer; it replaces any limiter written
 * beside it. A refusal Telegram returns as a response, not only a thrown one,
 * pauses the token (see `TelegramOutboundBudget.run`), and the call is never
 * repeated here.
 *
 * A cancellation that arrives while the call still waits for its turn, or in
 * the instant after it was granted and before the request was handed on, throws
 * `TelegramNotDispatchedError`: nothing was sent. A cancellation after the
 * request was handed on is the client's ordinary error and the outcome is
 * unknown, not a definite failure.
 */
export function telegramBudgetTransformer(budget: TelegramOutboundBudget): Transformer {
  return async (previous, method, payload, signal) => {
    const gate = platformSignal(signal);
    let handedOn = false;
    try {
      return await budget.run(method, payload, gate.signal, () => {
        handedOn = true;
        return previous(method, payload, signal);
      });
    } catch (error) {
      if (!handedOn && gate.signal?.aborted && error === gate.signal.reason) {
        throw new TelegramNotDispatchedError(
          'request',
          'the Telegram request was cancelled before it was sent',
          { cause: error },
        );
      }
      throw error;
    } finally {
      gate.release();
    }
  };
}
