/**
 * A framework for the `onError` hook — the project supplies a code map and an
 * envelope shape, `createErrorHook` does the normalisation.
 *
 * Every project writes the same `onError`: turn a thrown value into one wire
 * shape, mapping stitchkit's own error codes to the app's public codes. The
 * exhaustive `codeMap` (`satisfies Record<StitchErrorCode, …>`) is the point —
 * a new `StitchErrorCode` in an upgrade breaks the map at compile time instead
 * of leaking stitchkit's code to the wire. The envelope stays app-owned via
 * `render`, so the core prescribes no domain shape (ADR 0002).
 *
 * ```ts
 * const onError = createErrorHook({
 *   codeMap: {
 *     BAD_REQUEST: 'bad_request', VALIDATION_ERROR: 'bad_request',
 *     UNAUTHORIZED: 'unauthenticated', FORBIDDEN: 'forbidden',
 *     NOT_FOUND: 'not_found', METHOD_NOT_ALLOWED: 'not_found',
 *     CONFLICT: 'conflict', RATE_LIMITED: 'rate_limited',
 *     INTERNAL_SERVER_ERROR: 'internal',
 *   } satisfies Record<StitchErrorCode, string>,
 *   render: (info) => ({ ok: false, error: { code: info.code, message: info.message } }),
 * });
 * createServer({ services, hooks: { onError } });
 * ```
 */
import { AppError, isStitchErrorCode, type StitchErrorCode } from '../contract';
import type { LifecycleHooks } from './types';

/** The normalised error handed to `render` — code already remapped. */
export interface ResolvedError {
  /** Wire code — the app code from `codeMap` for a stitch error, else the thrown code. */
  code: string;
  /** HTTP status. */
  status: number;
  /** Safe message — the `AppError` message, or a generic string for a raw throw. */
  message: string;
  /** Structured details, when the thrown `AppError` carried them. */
  details?: Record<string, unknown>;
  /** Recovery hint, when the thrown `AppError` carried one. */
  hint?: string;
}

/** Config for `createErrorHook`. */
export interface ErrorHookConfig<TWireCode extends string = string> {
  /**
   * Remap stitchkit's own error codes to your public wire codes. Exhaustive —
   * `satisfies Record<StitchErrorCode, …>` makes a new framework code a compile
   * error here. Codes you threw yourself (not stitchkit's) pass through as-is.
   */
  codeMap?: Record<StitchErrorCode, TWireCode>;
  /** Build the response body from the resolved error. */
  render: (info: ResolvedError) => unknown;
  /** Observe the raw thrown value before rendering — logging / metrics. */
  onError?: (error: unknown, info: ResolvedError) => void;
}

/** Build an `onError` hook from a code map + envelope renderer. */
export function createErrorHook<TWireCode extends string = string>(
  config: ErrorHookConfig<TWireCode>,
): NonNullable<LifecycleHooks['onError']> {
  return (_ctx, error) => {
    const isApp = AppError.is(error);
    // A raw (non-`AppError`) throw is an internal fault — never leak its message.
    const rawCode = isApp ? error.code : 'INTERNAL_SERVER_ERROR';
    const code =
      config.codeMap && isStitchErrorCode(rawCode) ? config.codeMap[rawCode] : rawCode;
    const info: ResolvedError = {
      code,
      status: isApp ? error.status : 500,
      message: isApp ? error.message : 'Internal server error',
      details: isApp ? error.details : undefined,
      hint: isApp ? error.hint : undefined,
    };
    config.onError?.(error, info);
    return new Response(JSON.stringify(config.render(info)), {
      status: info.status,
      headers: { 'content-type': 'application/json' },
    });
  };
}
