/**
 * Global brand for cross-realm / cross-chunk identification, mirroring
 * `AppError`'s (→ ADR 0032). The published dist bundles this class into more
 * than one chunk (the browser build and the server build each carry a copy),
 * so an `ApiError` thrown by a client from one chunk fails `instanceof`
 * against the other chunk's class — which silently killed the
 * `ApiError → AppError` conversion in `implementRemote` and flattened every
 * remote failure to `INTERNAL_SERVER_ERROR`.
 */
const API_ERROR_BRAND = Symbol.for('stitchkit.ApiError');

/**
 * The text an `ApiError` carries when nothing supplied one.
 *
 * The old fallback was `API Error: ${code}`, which reads like an explanation and
 * is not one: a caller could not tell "the origin explained this failure" from
 * "nothing explained it", because `message` was a plausible non-empty string
 * either way. Those are different answers, and merging them is what sent one
 * consumer hunting a permission refusal that never happened — the code alone
 * read as one.
 *
 * Fixed in the text rather than in a field beside it, because the text is the
 * channel that survives a hop: `implementRemote` copies `message` into the
 * `AppError` it re-throws, so a fabricated line crosses to the NEXT consumer as
 * though the origin had written it, while a structural flag would stop at the
 * boundary — dead exactly where it is needed.
 *
 * An empty string counts as unsupplied: it explains nothing either, and `??`
 * alone would have let it through.
 */
function messageForCode(code: string, message: string | undefined): string {
  return message !== undefined && message.length > 0
    ? message
    : `${code} (no message supplied)`;
}

export class ApiError extends Error {
  readonly status: number;
  readonly details?: unknown;
  readonly hint?: string;
  readonly traceId?: string;
  readonly retryable?: boolean;

  /**
   * `status` defaults to 0 (the request never reached a server); `message`, when absent or
   * empty, says so rather than inventing an explanation; `cause` is the standard `Error` cause.
   */
  constructor(
    public readonly code: string,
    options: {
      status?: number;
      details?: unknown;
      message?: string;
      hint?: string;
      traceId?: string;
      retryable?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(
      messageForCode(code, options.message),
      'cause' in options ? { cause: options.cause } : undefined,
    );
    this.name = 'ApiError';
    this.status = options.status ?? 0;
    this.details = options.details;
    this.hint = options.hint;
    this.traceId = options.traceId;
    this.retryable = options.retryable;
    // Non-enumerable — invisible to JSON / spread, present for `is()`.
    Object.defineProperty(this, API_ERROR_BRAND, { value: true });
  }

  static is(error: unknown): error is ApiError {
    return typeof error === 'object' && error !== null && API_ERROR_BRAND in error;
  }
}

/**
 * A refusal the client raised itself, in the shape the server uses for the same failure.
 *
 * Before this, the client refused a bad argument in three shapes across two timings: a plain `Error`
 * rejected on one transport, the same plain `Error` thrown **synchronously** on the other, and a
 * missing multipart file reported as `UNKNOWN_ERROR` — the code whose whole meaning is *this client
 * cannot tell you what happened*, on the one refusal where dispatch provably never happened, while
 * the client guide instructs the reader never to conclude anything from that code.
 *
 * `status: 0` already means "this never reached the server" (`REQUEST_ABORTED`, `REQUEST_TIMEOUT`),
 * so `VALIDATION_ERROR` with `status: 0` reads as "refused here" against the server's `400` with no
 * new field and no new name. `details.issues` carries the same `{ path, code, message }` a 400
 * carries, so one rendering serves both.
 */
export function refuseLocally(path: string, message: string): ApiError {
  return new ApiError('VALIDATION_ERROR', {
    status: 0,
    details: { issues: [{ path, code: 'invalid_type', message }] },
    message,
  });
}
