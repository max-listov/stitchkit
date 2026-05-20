import { z } from 'zod';

/** Keys of a Zod object schema's shape — `[]` for a non-object or absent schema. */
export function objectShapeKeys(schema?: z.ZodType): string[] {
  return schema instanceof z.ZodObject ? Object.keys(schema.shape) : [];
}

/**
 * Merge an endpoint's `params` and `input` schemas into the single schema a
 * tool advertises.
 *
 * - Both object → one merged `z.object`. A key declared in both is a contract
 *   bug and throws.
 * - A non-object `input` (a union, a discriminated union, a refined / piped
 *   schema) is kept intact and intersected with `params` when present — the
 *   transport SDK converts it natively (a discriminated union becomes a clean
 *   `oneOf`).
 *
 * The merged schema is exactly the two source schemas side by side: nothing is
 * coerced, flattened or transformed, so the schema a tool advertises is the
 * schema its arguments are validated against (`executeToolMethod` parses each
 * source schema over its own slice of the args).
 */
export function mergeSchemas(
  paramsSchema?: z.ZodType<unknown>,
  inputSchema?: z.ZodType<unknown>,
): z.ZodType {
  if (paramsSchema && !(paramsSchema instanceof z.ZodObject)) {
    throw new Error('Tool params schema must be a z.object()');
  }
  const paramsObject = paramsSchema instanceof z.ZodObject ? paramsSchema : undefined;

  if (!inputSchema) {
    return paramsObject ?? z.object({});
  }

  if (inputSchema instanceof z.ZodObject) {
    if (paramsObject) {
      const conflicts = Object.keys(paramsObject.shape).filter(
        (key) => key in inputSchema.shape,
      );
      if (conflicts.length > 0) {
        throw new Error(
          `Schema merge conflict: ${conflicts.join(', ')} appear in both params and input`,
        );
      }
    }
    return z.object({ ...(paramsObject?.shape ?? {}), ...inputSchema.shape });
  }

  // Non-object input — a union / discriminated union / refined schema. Kept
  // intact; intersected with params so both are still enforced and advertised.
  return paramsObject ? z.intersection(paramsObject, inputSchema) : inputSchema;
}
