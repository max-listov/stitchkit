import { z } from 'zod';
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

  const msg = err instanceof Error ? err.message : String(err);
  const safeMessage = msg.length > 200 ? `${msg.slice(0, 200)}...` : msg;

  return new AppError('INTERNAL_SERVER_ERROR', safeMessage, 500);
}
