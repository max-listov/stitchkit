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
 * The thrown value is classified through the framework's own `normalizeError`
 * first, so a `ZodError` (invalid input) is an honest `VALIDATION_ERROR` 400 —
 * not a 500 — exactly as the framework default would render it.
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
import { isStitchErrorCode, type StitchErrorCode } from '../contract';
import { normalizeError } from '../internal/errors';
import type { LifecycleHooks } from './types';

/** The normalised error handed to `render` — code already remapped. */
export interface ResolvedError {
  /** Wire code — the app code from `codeMap` for a stitch error, else the thrown code. */
  code: string;
  /** HTTP status. */
  status: number;
  /** Safe message — the `AppError` / `ZodError` summary, or a generic string for a raw throw. */
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
    // Normalise first — the same classification the framework default uses:
    // a `ZodError` (bad input) becomes `VALIDATION_ERROR` 400, an `AppError`
    // keeps its code / status / details, anything else becomes a generic 500
    // with no message leak. Without this a client fault (invalid input) would
    // reach `render` as a raw non-`AppError` and be dressed as a 500.
    const appErr = normalizeError(error);
    const code =
      config.codeMap && isStitchErrorCode(appErr.code)
        ? config.codeMap[appErr.code]
        : appErr.code;
    const info: ResolvedError = {
      code,
      status: appErr.status,
      message: appErr.message,
      details: appErr.details,
      hint: appErr.hint,
    };
    config.onError?.(error, info);
    return new Response(JSON.stringify(config.render(info)), {
      status: info.status,
      headers: { 'content-type': 'application/json' },
    });
  };
}
