import { type ZodType, z } from 'zod';
import { AppError } from '../contract';

/** The dotted path of a Zod issue — `(root)` for a top-level issue. */
function issuePath(path: ReadonlyArray<PropertyKey>): string {
  return path.length > 0 ? path.map(String).join('.') : '(root)';
}

export function formatZodError(error: z.ZodError): string {
  const issues = error.issues.slice(0, 5);
  const lines = issues.map((issue) => `${issuePath(issue.path)}: ${issue.message}`);
  const suffix =
    error.issues.length > 5 ? `\n...and ${error.issues.length - 5} more issues` : '';
  return lines.join('\n') + suffix;
}

/** One field-level validation issue — the structured sibling of `formatZodError`. */
export interface ZodIssueSummary {
  /** Dotted path to the offending field (`(root)` for a top-level issue). */
  path: string;
  /** Zod issue code (e.g. `invalid_type`, `too_small`). */
  code: string;
  /** Human-readable message for this field. */
  message: string;
}

/**
 * Project a `ZodError` into structured, wire-safe field issues — path / code /
 * message only, nothing server-internal. For a machine client that matches on
 * fields rather than parsing the text `message`. Returns every issue; a caller
 * that bounds response size slices it (see `normalizeError`).
 */
export function zodIssues(error: z.ZodError): ZodIssueSummary[] {
  return error.issues.map((issue) => ({
    path: issuePath(issue.path),
    code: issue.code,
    message: issue.message,
  }));
}

/** Cap on structured issues carried in a `VALIDATION_ERROR`'s `details`. */
const MAX_DETAIL_ISSUES = 20;

/**
 * The stable error code for a thrown value — `AppError.code`, `VALIDATION_ERROR`
 * for a `ZodError`, else `undefined`. Side-effect-free (unlike `normalizeError`,
 * it never logs): for access-log attribution on a path where the response is
 * produced elsewhere — a custom `onError` hook that returns its own `Response`.
 */
export function errorCode(err: unknown): string | undefined {
  if (AppError.is(err)) return err.code;
  if (err instanceof z.ZodError) return 'VALIDATION_ERROR';
  return undefined;
}

export function normalizeError(err: unknown): AppError {
  if (AppError.is(err)) return err;

  if (err instanceof z.ZodError) {
    // Carry structured field issues in `details` alongside the text `message`,
    // so a machine client matches on fields instead of parsing the message.
    return new AppError('VALIDATION_ERROR', formatZodError(err), 400, {
      issues: zodIssues(err).slice(0, MAX_DETAIL_ISSUES),
    });
  }

  // An unexpected error: log the real cause server-side, but return a generic
  // message to the caller — a raw `Error.message` can carry internal detail
  // (a DB connection string, a file path, a stack fragment).
  console.error('[stitchkit] unhandled error:', err);
  return new AppError('INTERNAL_SERVER_ERROR', 'Internal server error', 500);
}

/**
 * Validate a handler's return value against the contract `output` schema. A
 * mismatch is a **server** fault (the handler broke its own contract) — shared
 * by the HTTP and tool transports so both report it identically.
 */
export function validateHandlerOutput(
  schema: ZodType,
  data: unknown,
): { ok: true; data: unknown } | { ok: false; message: string } {
  const parsed = schema.safeParse(data);
  if (parsed.success) return { ok: true, data: parsed.data };
  return {
    ok: false,
    message: `Handler output does not match the contract: ${formatZodError(parsed.error)}`,
  };
}
