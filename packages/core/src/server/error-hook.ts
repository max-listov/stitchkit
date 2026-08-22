/**
 * A framework for the `onError` hook — the project supplies a code map and an
 * envelope shape, `createErrorHook` does the normalisation.
 *
 * Every project writes the same `onError`: turn a thrown value into one wire
 * shape, mapping stitchkit's own error codes to the app's public codes. The map
 * is partial — list the codes you have an opinion about, and an unlisted one
 * travels as itself unless `unmappedCode` supplies one declarative fallback.
 * Codes the project throws on its own always pass through unchanged. A
 * project whose envelope is a published contract adds `satisfies
 * Record<StitchErrorCode, …>` to its own map and buys the stricter deal: a code
 * added by a later release then breaks the build instead of reaching the wire
 * in stitchkit's spelling. The envelope stays app-owned via `render`, so the
 * core prescribes no domain shape (ADR 0002).
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
 *   },
 *   render: (info, ctx) => ({
 *     ok: false,
 *     error: { code: info.code, message: info.message },
 *     traceId: ctx.traceId,
 *   }),
 * });
 * createServer({ services, hooks: { onError } });
 * ```
 */

import type { RuntimeContext } from '../contract';
import { isStitchErrorCode, type StitchErrorCode } from '../contract';
import { normalizeError } from '../internal/errors';
import type { LifecycleHooks, MethodDef } from './types';

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
  codeMap?: Partial<Record<StitchErrorCode, TWireCode>>;
  /**
   * Wire code for every unmapped stitchkit code, or a resolver for grouping
   * them. Explicit `codeMap` entries win. Project-owned codes never use this
   * fallback and continue to pass through unchanged.
   */
  unmappedCode?: TWireCode | ((code: StitchErrorCode) => TWireCode);
  /** Build the response body from the resolved error. */
  /**
   * Build the response body from the resolved error. `ctx` is the request's
   * `RuntimeContext` — read `ctx.traceId` / `ctx.spanId` to put a correlation id
   * in the envelope, which is the ordinary reason to have one. Declaring the
   * parameter is optional: a one-argument `render` stays assignable.
   */
  render: (
    info: ResolvedError,
    ctx: RuntimeContext,
    endpoint?: MethodDef,
  ) => unknown | Promise<unknown>;
  /**
   * Observe the raw thrown value before rendering — logging, metrics or
   * asynchronous request attribution. The matched endpoint is absent for
   * failures that happen before the router resolves an operation.
   */
  onError?: (
    error: unknown,
    info: ResolvedError,
    ctx: RuntimeContext,
    endpoint?: MethodDef,
  ) => unknown | Promise<unknown>;
}

/** Build an `onError` hook from a code map + envelope renderer. */
export function createErrorHook<TWireCode extends string = string>(
  config: ErrorHookConfig<TWireCode>,
): NonNullable<LifecycleHooks['onError']> {
  return async (ctx, error, endpoint) => {
    // Normalise first — the same classification the framework default uses:
    // a `ZodError` (bad input) becomes `VALIDATION_ERROR` 400, an `AppError`
    // keeps its code / status / details, anything else becomes a generic 500
    // with no message leak. Without this a client fault (invalid input) would
    // reach `render` as a raw non-`AppError` and be dressed as a 500.
    const appErr = normalizeError(error);
    // A map need not be exhaustive: the framework grows `StitchErrorCode` in
    // ordinary releases. The optional fallback handles only that narrowed
    // framework vocabulary; project codes preserve their existing passthrough.
    const stitchCode = isStitchErrorCode(appErr.code) ? appErr.code : undefined;
    const mapped = stitchCode === undefined ? undefined : config.codeMap?.[stitchCode];
    const fallback =
      mapped === undefined && stitchCode !== undefined
        ? typeof config.unmappedCode === 'function'
          ? config.unmappedCode(stitchCode)
          : config.unmappedCode
        : undefined;
    const code = mapped ?? fallback ?? appErr.code;
    const info: ResolvedError = {
      code,
      status: appErr.status,
      message: appErr.message,
      details: appErr.details,
      hint: appErr.hint,
    };
    await config.onError?.(error, info, ctx, endpoint);
    const body = await config.render(info, ctx, endpoint);
    return new Response(JSON.stringify(body), {
      status: info.status,
      headers: { 'content-type': 'application/json' },
    });
  };
}
