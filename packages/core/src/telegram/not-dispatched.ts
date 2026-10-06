/**
 * Where a Bot API request stopped before any byte of it was written: the address lookup, the
 * connection, or the request itself (a body that could not be read).
 */
export type TelegramNotDispatchedStage = 'lookup' | 'connect' | 'request';

/**
 * The request provably never reached Telegram, so sending it again cannot duplicate a message.
 * Thrown only before the first byte is written; any failure after that is an ordinary error,
 * because the request may have arrived. Its message names no address that carries the token.
 */
export class TelegramNotDispatchedError extends Error {
  override readonly name = 'TelegramNotDispatchedError';
  readonly code = 'TELEGRAM_NOT_DISPATCHED';
  constructor(
    readonly stage: TelegramNotDispatchedStage,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * This error, whichever copy of the package made it: its name and code identify it. Only this
 * error is known to carry no address, so it is the one a sender passes through unchanged.
 */
export function isTelegramNotDispatchedError(
  error: unknown,
): error is TelegramNotDispatchedError {
  return (
    error instanceof TelegramNotDispatchedError ||
    (error instanceof Error &&
      error.name === 'TelegramNotDispatchedError' &&
      Reflect.get(error, 'code') === 'TELEGRAM_NOT_DISPATCHED')
  );
}

/** Whether `error`, or an error it wraps, is a request that never left. */
export function isTelegramNotDispatched(error: unknown, depth = 0): boolean {
  if (error instanceof TelegramNotDispatchedError) return true;
  if (typeof error !== 'object' || error === null || depth > 4) return false;
  if (Reflect.get(error, 'code') === 'TELEGRAM_NOT_DISPATCHED') return true;
  // grammY wraps a transport failure in its own HttpError under `error`.
  const nested = Reflect.get(error, 'cause') ?? Reflect.get(error, 'error');
  return nested !== error && isTelegramNotDispatched(nested, depth + 1);
}
