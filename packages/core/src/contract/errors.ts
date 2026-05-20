/**
 * The public error envelope — the JSON shape of every error response, and the
 * one type the server (`AppError.toJSON`) and the typed HTTP client are
 * declared against.
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
 * The framework's error model — a stable `code`, an HTTP `status`, optional
 * structured `details` and a `hint`. `toJSON()` renders the public error
 * envelope. Throw it directly, or via the typed helpers below.
 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
    public readonly status: number = 500,
    public readonly details?: Record<string, unknown>,
    public readonly hint?: string,
  ) {
    super(message ?? code);
    this.name = 'AppError';
  }

  static is(err: unknown): err is AppError {
    return err instanceof AppError;
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

const ERROR_STATUS: Record<string, number> = {
  NOT_FOUND: 404,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  VALIDATION_ERROR: 400,
  INTERNAL_SERVER_ERROR: 500,
};

/** Throw an `AppError` for any `code`, mapping known codes to their HTTP status (else 500). */
export function appError(
  code: string,
  message?: string,
  details?: Record<string, unknown>,
): never {
  throw new AppError(code, message, ERROR_STATUS[code] ?? 500, details);
}
