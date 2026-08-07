import { type ZodType, z } from 'zod';
import { AppError } from '../contract';
import { isRecord } from './typed';

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

/**
 * The message a **server-side record** should carry for a failure — an audit
 * row, not a response.
 *
 * Normally the envelope's: it is truthful for an `AppError` or a `ZodError`, and
 * it is what the caller was told, so the record and the response agree. The
 * exception is the scrubbed one — an unexpected throw becomes
 * `INTERNAL_SERVER_ERROR` / "Internal server error", which tells a later reader
 * nothing at all, and there the raw message goes in instead.
 *
 * The line this holds is not "the framework never touches a raw message" but
 * **"a raw message never crosses to the caller"**. Shared by the HTTP and tool
 * paths so that line is one rule in one place. → ADR 0042.
 */
export function recordedErrorMessage(
  code: string,
  envelopeMessage: string | undefined,
  thrown: unknown,
): string | undefined {
  if (code === 'INTERNAL_SERVER_ERROR' && thrown !== undefined) {
    if (thrown instanceof Error) return thrown.message;
    if (typeof thrown === 'string') return thrown;
  }
  return envelopeMessage;
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
 * Every key present before validation and absent after it, as dot-paths.
 *
 * Deep on purpose: a field trimmed three levels down is exactly what a top-level
 * comparison misses, and a half-answer sends someone hunting the wrong endpoint.
 * Arrays are walked by index; a `.loose()` / `.catchall()` schema keeps its
 * extras, so it reports nothing.
 */
function strippedPaths(before: unknown, after: unknown, prefix: string): string[] {
  if (Array.isArray(before)) {
    if (!Array.isArray(after)) return [];
    return before.flatMap((item, i) => strippedPaths(item, after[i], `${prefix}[${i}]`));
  }
  if (!isRecord(before) || !isRecord(after)) return [];
  const paths: string[] = [];
  for (const [key, value] of Object.entries(before)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!(key in after)) {
      paths.push(path);
      continue;
    }
    paths.push(...strippedPaths(value, after[key], path));
  }
  return paths;
}

/**
 * Validate a handler's return value against the contract `output` schema. A
 * mismatch is a **server** fault (the handler broke its own contract) — shared
 * by the HTTP and tool transports so both report it identically.
 *
 * `onStripped` is the migration diagnostic: a handler returning more than its
 * contract declares has the extra fields **deleted**, correctly but invisibly —
 * types cannot catch it (structural typing does not reject excess properties) and
 * nothing logs it. Pass a reporter to find out; omit it and nothing is computed.
 */
export function validateHandlerOutput(
  schema: ZodType,
  data: unknown,
  onStripped?: (paths: string[]) => void,
): { ok: true; data: unknown } | { ok: false; message: string } {
  const parsed = schema.safeParse(data);
  if (parsed.success) {
    // The diff runs ONLY when a diagnostic is attached — with the flag off there
    // is no walk and no cost on the response path. → ADR 0037.
    if (onStripped) {
      const paths = strippedPaths(data, parsed.data, '');
      if (paths.length > 0) onStripped(paths);
    }
    return { ok: true, data: parsed.data };
  }
  return {
    ok: false,
    message: `Handler output does not match the contract: ${formatZodError(parsed.error)}`,
  };
}

/**
 * Enforce the presence or absence of a contract output before a transport
 * presents it. `null` is JSON data when a schema accepts it; `undefined` never
 * is. Without a schema, nullish returns mean "no result" and any other value is
 * an undeclared response.
 */
export function validateDeclaredOutput(
  schema: ZodType | undefined,
  data: unknown,
  onStripped?: (paths: string[]) => void,
): { ok: true; data: unknown } | { ok: false; message: string } {
  if (!schema) {
    if (data === undefined || data === null) return { ok: true, data };
    return {
      ok: false,
      message: 'Handler returned data but the contract declares no output',
    };
  }
  if (data === undefined) {
    return {
      ok: false,
      message: 'Handler returned undefined but the contract declares an output',
    };
  }
  return validateHandlerOutput(schema, data, onStripped);
}
