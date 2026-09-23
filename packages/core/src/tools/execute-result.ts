/**
 * What a tool call answers — success with data, or a canonical failure — and
 * the one place a thrown value becomes that failure. The normalized error and
 * the raw cause ride beside a failure in-process, never inside it.
 */
import {
  AppError,
  isRetryableStatus,
  isStitchErrorCode,
  STITCH_ERROR_STATUS,
} from '../contract/errors';
import { normalizeError } from '../contract/normalize';
import { isRecord } from '../internal/typed';

export type ToolResult =
  | { ok: true; data: unknown }
  | {
      ok: false;
      code: string;
      details?: unknown;
      hint?: string;
      /**
       * A declared retry class, carried so it survives a process hop.
       *
       * The normalized `AppError` lives in a `WeakMap` keyed by the result
       * object, which a serialized failure crossing MCP or the CLI cannot take
       * with it — `toolErrorFromResult` rebuilds from `{code, details, hint}`
       * and resolves the status from the code. A declaration that contradicts
       * its status class would be lost exactly there, which is the failure
       * already recorded for coding-tool refusals.
       */
      retryable?: boolean;
    };

export type ToolFailure = Extract<ToolResult, { ok: false }>;

/**
 * The model-facing failure deliberately omits HTTP status and the raw cause.
 * In-process composition still needs the exact normalized AppError, so retain
 * it out-of-band for the lifetime of the result object. A WeakMap keeps the
 * public envelope and its JSON representation unchanged.
 */
const normalizedToolErrors = new WeakMap<
  ToolFailure,
  { normalized: AppError; cause: unknown }
>();

/**
 * Normalise any thrown value into a failed `ToolResult` — the one place an
 * `AppError` becomes a tool error. Shared by `executeToolMethod` and both
 * transport mounts so every tool error has one shape.
 */
export function toolResultFromError(err: unknown): ToolFailure {
  const appErr = normalizeError(err);
  const result: ToolFailure = {
    ok: false,
    code: appErr.code,
    details: appErr.details ?? { message: appErr.message },
    ...(appErr.hint && { hint: appErr.hint }),
    // Resolved HERE, declared or derived, and carried on the failure — because
    // the only other place the status is known is the WeakMap this object
    // keys, and a failure that crosses a process boundary does not take it
    // along. Rebuilt from `{code, details, hint}` on the far side, an
    // application's `status: 429` would resolve to 500 and read as
    // unrecoverable. The failure is the one thing that crosses; the answer
    // rides on it.
    retryable: appErr.retryable ?? isRetryableStatus(appErr.status),
  };
  normalizedToolErrors.set(result, { normalized: appErr, cause: err });
  return result;
}

/** Recover the normalized AppError behind one canonical failed tool result. */
export function toolErrorFromResult(result: ToolFailure): AppError {
  const retained = normalizedToolErrors.get(result);
  if (retained) return retained.normalized;

  const details = isRecord(result.details) ? result.details : undefined;
  const message = typeof details?.message === 'string' ? details.message : result.code;
  const status = isStitchErrorCode(result.code) ? STITCH_ERROR_STATUS[result.code] : 500;
  return new AppError(
    result.code,
    message,
    status,
    details,
    result.hint,
    undefined,
    result.retryable,
  );
}

/** Original in-process failure; never part of the serialized tool envelope. */
export function toolCauseFromResult(result: ToolFailure): unknown {
  return normalizedToolErrors.get(result)?.cause;
}
