import { type ZodType, z } from 'zod';
import { AppError } from '../contract';

export function formatZodError(error: z.ZodError): string {
  const issues = error.issues.slice(0, 5);
  const lines = issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
  const suffix =
    error.issues.length > 5 ? `\n...and ${error.issues.length - 5} more issues` : '';
  return lines.join('\n') + suffix;
}

export function normalizeError(err: unknown): AppError {
  if (AppError.is(err)) return err;

  if (err instanceof z.ZodError) {
    return new AppError('VALIDATION_ERROR', formatZodError(err), 400);
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
