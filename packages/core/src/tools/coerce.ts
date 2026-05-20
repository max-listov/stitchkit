import { z } from 'zod';
import { safeJsonParse } from '../internal/safe-json';

/** True for a field whose value should be JSON-parsed when it arrives as a string. */
function needsJsonCoercion(field: z.core.$ZodType): boolean {
  if (field instanceof z.ZodArray || field instanceof z.ZodObject) return true;
  if (
    field instanceof z.ZodOptional ||
    field instanceof z.ZodNullable ||
    field instanceof z.ZodDefault
  ) {
    return needsJsonCoercion(field.unwrap());
  }
  return false;
}

/**
 * Coerce JSON-stringified array/object arguments — an LLM sometimes
 * double-serializes a nested value (sends `"[1,2]"` instead of `[1,2]`).
 *
 * Only fields the schema declares as an array/object are touched, and only
 * when the incoming value is a string. The transform operates on the
 * **arguments**, never the schema — so the advertised tool schema stays
 * exactly the contract schema (correct types, correct `required`).
 */
export function coerceJsonArgs(
  args: Record<string, unknown>,
  schema: z.ZodType | undefined,
): Record<string, unknown> {
  if (!(schema instanceof z.ZodObject)) return args;
  const shape = schema.shape;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const field = shape[key];
    if (field && needsJsonCoercion(field) && typeof value === 'string') {
      try {
        out[key] = safeJsonParse(value);
        continue;
      } catch {
        // Not JSON — leave the raw string; validation rejects it normally.
      }
    }
    out[key] = value;
  }
  return out;
}
