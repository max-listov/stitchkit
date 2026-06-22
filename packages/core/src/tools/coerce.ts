import { z } from 'zod';
import { safeJsonParse } from '../internal/safe-json';
import { isRecord } from '../internal/typed';

/** True for a schema whose value should be JSON-parsed when it arrives as a string. */
function needsJsonCoercion(schema: z.core.$ZodType): boolean {
  if (
    schema instanceof z.ZodArray ||
    schema instanceof z.ZodObject ||
    schema instanceof z.ZodRecord ||
    schema instanceof z.ZodTuple ||
    schema instanceof z.ZodUnion // includes ZodDiscriminatedUnion
  ) {
    return true;
  }
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault
  ) {
    return needsJsonCoercion(schema.unwrap());
  }
  return false;
}

/** The variant of a discriminated union whose discriminator matches `value`. */
function matchingVariant(
  union: z.ZodDiscriminatedUnion,
  value: Record<string, unknown>,
): z.ZodObject | undefined {
  const disc = union.def.discriminator;
  const tag = value[disc];
  for (const option of union.def.options) {
    if (!(option instanceof z.ZodObject)) continue;
    const field = option.shape[disc];
    if (field instanceof z.ZodLiteral && field.def.values.some((v) => v === tag))
      return option;
    if (field instanceof z.ZodEnum && field.options.some((v) => v === tag)) return option;
  }
  return undefined;
}

/** Coerce a single value against its schema — recursively, in lockstep with the
 *  schema's nesting, so a double-serialized value at any depth is repaired. */
function coerceValue(value: unknown, schema: z.core.$ZodType | undefined): unknown {
  if (!schema) return value;

  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault
  ) {
    return coerceValue(value, schema.unwrap());
  }

  // A string where the schema wants a structure → JSON-parse, then recurse into
  // the parsed shape (so nested double-serialization is repaired too).
  let current = value;
  if (typeof current === 'string' && needsJsonCoercion(schema)) {
    try {
      current = safeJsonParse(current);
    } catch {
      return value; // not JSON — leave it; validation rejects it normally.
    }
  }

  if (schema instanceof z.ZodObject && isRecord(current)) {
    const shape = schema.shape;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(current)) {
      out[key] = coerceValue(item, shape[key]);
    }
    return out;
  }
  if (schema instanceof z.ZodArray && Array.isArray(current)) {
    return current.map((item) => coerceValue(item, schema.element));
  }
  if (schema instanceof z.ZodDiscriminatedUnion && isRecord(current)) {
    const variant = matchingVariant(schema, current);
    return variant ? coerceValue(current, variant) : current;
  }
  return current;
}

/**
 * Coerce JSON-stringified array/object arguments — an LLM sometimes
 * double-serializes a nested value (sends `"[1,2]"` instead of `[1,2]`).
 *
 * Operates recursively against the schema (object fields, array items, and the
 * matching variant of a discriminated union) so a stringified value at any depth
 * is repaired, not just a top-level field. The transform touches the **arguments**
 * only — the advertised tool schema stays exactly the contract schema.
 */
export function coerceJsonArgs(
  args: Record<string, unknown>,
  schema: z.ZodType | undefined,
): Record<string, unknown> {
  const coerced = coerceValue(args, schema);
  return isRecord(coerced) ? coerced : args;
}
