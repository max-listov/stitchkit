/**
 * The public error envelope — the JSON shape of every HTTP error response, and
 * the one type the server (`AppError.toJSON`) and the typed HTTP client are
 * declared against. Tool (MCP / agent) errors use a flatter, model-facing
 * shape instead — see `formatToolError` in `tools/mount.ts`.
 */
export interface ErrorEnvelope {
  error: {
    /** Stable, machine-readable error code. */
    code: string;
    /** Human-readable message. */
    message?: string;
    /** Structured error context. */
    details?: unknown;
    /** A remediation hint. */
    hint?: string;
  };
}

/**
 * Global brand for cross-realm / cross-chunk identification. `AppError.is` checks
 * this Symbol, **not `instanceof`**: the framework is bundled into more than one
 * chunk (the browser build and the server build each carry their own copy of this
 * class), so an `AppError` — or a consumer subclass of it — thrown across that
 * boundary fails an `instanceof` against a *different* chunk's copy, and would be
 * misclassified as `INTERNAL_SERVER_ERROR`. `Symbol.for` resolves to one symbol
 * process-wide, so every copy of `AppError` stamps and recognises the same brand.
 * → ADR 0032.
 */
const APP_ERROR_BRAND = Symbol.for('stitchkit.AppError');

/**
 * The framework's error model — a stable `code`, an HTTP `status`, optional
 * structured `details` and a `hint`. `toJSON()` renders the public error
 * envelope. Throw it directly, or via the typed helpers below.
 */
export class AppError<
  TCode extends string = string,
  TDetails extends Record<string, unknown> | undefined = Record<string, unknown> | undefined,
> extends Error {
  constructor(
    public readonly code: TCode,
    message?: string,
    public readonly status: number = 500,
    public readonly details?: TDetails,
    public readonly hint?: string,
    /**
     * Transport trace id (`x-request-id`) preserved across the
     * `ApiError → AppError` conversion in `implementRemote`. Metadata for
     * logs/observability — deliberately NOT part of `toJSON()`'s envelope.
     */
    public readonly traceId?: string,
    /**
     * Whether repeating this call could succeed, when the error declares it.
     *
     * Metadata, like `traceId`, and for the same reason: it is not part of
     * `toJSON()`'s HTTP envelope. It exists for the MODEL-facing tool envelope,
     * where the next move — wait and retry, fix the input, or stop — is the
     * whole decision a refusal has to support. Left `undefined`, the class is
     * derived from `status`; declared, it wins, for the domain failure whose
     * status says one thing and whose truth is the other.
     */
    public readonly retryable?: boolean,
  ) {
    super(message ?? code);
    this.name = 'AppError';
    // Non-enumerable brand — invisible to JSON / spread / Object.keys, present
    // for `is()`. Set on every instance, including consumer subclasses (their
    // `super()` runs this).
    Object.defineProperty(this, APP_ERROR_BRAND, { value: true });
  }

  static is(err: unknown): err is AppError {
    return typeof err === 'object' && err !== null && APP_ERROR_BRAND in err;
  }

  toJSON(): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details && { details: this.details }),
        ...(this.hint && { hint: this.hint }),
      },
    };
  }
}

/** Throw a `404 NOT_FOUND` error. */
export function notFound(message = 'Not found'): never {
  throw new AppError('NOT_FOUND', message, 404);
}

/** Throw a `400 BAD_REQUEST` error, optionally with structured `details`. */
export function badRequest(message: string, details?: Record<string, unknown>): never {
  throw new AppError('BAD_REQUEST', message, 400, details);
}

/** Throw a `401 UNAUTHORIZED` error. */
export function unauthorized(message = 'Unauthorized'): never {
  throw new AppError('UNAUTHORIZED', message, 401);
}

/** Throw a `403 FORBIDDEN` error. */
export function forbidden(message = 'Forbidden'): never {
  throw new AppError('FORBIDDEN', message, 403);
}

/** Throw a `409 CONFLICT` error, optionally with structured `details`. */
export function conflict(message = 'Conflict', details?: Record<string, unknown>): never {
  throw new AppError('CONFLICT', message, 409, details);
}

/** Throw a `429 RATE_LIMITED` error. */
export function rateLimited(message = 'Too many requests'): never {
  throw new AppError('RATE_LIMITED', message, 429);
}

/**
 * `code → HTTP status` for the error codes **stitchkit itself** emits — the
 * typed helpers above, `normalizeError` (`VALIDATION_ERROR` /
 * `INTERNAL_SERVER_ERROR`) and the router (`METHOD_NOT_ALLOWED`). This map is the
 * single source of truth: `StitchErrorCode` is derived from its keys, so the two
 * never drift. App-defined codes are free strings the core never sees (ADR 0002);
 * these are stitchkit's own, published so a consumer can map stitch → app codes
 * against a stable, typed reference instead of a hand-copied string list.
 * → ADR 0026.
 */
export const STITCH_ERROR_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  VALIDATION_ERROR: 400,
  FILE_INVALID_PATH: 400,
  FILE_OUTSIDE_ROOT: 400,
  FILE_NOT_FOUND: 404,
  FILE_NOT_REGULAR: 422,
  FILE_INSPECTION_REJECTED: 422,
  FILE_TOO_LARGE: 413,
  FILE_EXISTS: 409,
  REALTIME_CONTRACT_VIOLATION: 500,
  APPLICATION_NOT_ACCEPTING: 503,
  GRAMMY_WEBHOOK_NOT_ACCEPTING: 503,
  // Managed runtime tools (→ ADR 0081, 0082). They reach a caller through a
  // tool result rather than an HTTP response, but they are still codes the
  // FRAMEWORK throws — and while they were missing here `isStitchErrorCode`
  // answered `false` for them, so both `codeMap` and the `unmappedCode`
  // resolver skipped them and the code travelled to the wire in stitchkit's
  // spelling. "Map every framework code to my vocabulary" silently missed four.
  // A contract endpoint mounted without its handler by the dev-only
  // `onMissingHandler: 'stub'` policy. Registered rather than thrown ad hoc:
  // the framework must not emit a code its own registry does not know, or the
  // code travels in stitchkit's spelling past every consumer `codeMap` — the
  // failure the four managed-runtime codes above already paid for.
  NOT_IMPLEMENTED: 501,
  WAIT_TIMEOUT: 408,
  WAIT_FAILED: 409,
  DOWNLOAD_NOT_FOUND: 404,
  VIEW_HTTP_ERROR: 502,
  OPERATION_NOT_SUCCEEDED: 409,
  STREAM_ITEM_INVALID: 500,
  STREAM_FRAME_TOO_LARGE: 500,
  STREAM_TERMINAL_MISSING: 500,
  STREAM_LIFETIME_EXCEEDED: 408,
  // Coding-tool refusals (→ `coding-tool-refusals.ts`). They too reach a model
  // through a tool result, and they used to live in a private status map beside
  // that vocabulary. A second map is a second source of truth, and it leaked in
  // one exact place: `toolErrorFromResult` rebuilds an envelope that crossed a
  // process boundary (MCP, CLI) and resolves its status HERE, so a refusal
  // absent from this map came back 500 — the declared 503 never survived the
  // hop. Measured before the fix: `SANDBOX_UNAVAILABLE` → 500, against
  // `NOT_FOUND` → 404 and `WAIT_TIMEOUT` → 408 as controls.
  SANDBOX_UNAVAILABLE: 503,
  SANDBOX_INSUFFICIENT: 503,
  SPILL_REFERENCE_UNKNOWN: 404,
  INTERNAL_SERVER_ERROR: 500,
} satisfies Record<string, number>;

/**
 * Whether a status class means "the same call could work later".
 *
 * Deliberately not "any 5xx". `REALTIME_CONTRACT_VIOLATION`,
 * `STREAM_ITEM_INVALID` and `FRAME_TOO_LARGE` are all 500 and all deterministic
 * — the same call fails the same way every time, and telling a model to retry
 * them buys nothing but billed turns. 408 and 504 are timeouts, 429 is a rate
 * limit, 502 and 503 are an upstream that may return; those are the ones where
 * waiting is a strategy rather than a hope.
 */
export function isRetryableStatus(status: number): boolean {
  return (
    status === 408 || status === 429 || status === 502 || status === 503 || status === 504
  );
}

/** A code stitchkit itself emits — derived from `STITCH_ERROR_STATUS` (no dup). */
export type StitchErrorCode = keyof typeof STITCH_ERROR_STATUS;

/** Type guard — is `code` one of stitchkit's own error codes? */
export function isStitchErrorCode(code: string): code is StitchErrorCode {
  return Object.hasOwn(STITCH_ERROR_STATUS, code);
}

/** Throw an `AppError` for any `code`, mapping a stitch code to its HTTP status (else 500). */
export function appError(
  code: string,
  message?: string,
  details?: Record<string, unknown>,
): never {
  throw new AppError(
    code,
    message,
    isStitchErrorCode(code) ? STITCH_ERROR_STATUS[code] : 500,
    details,
  );
}
