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

/**
 * True when the schema takes a raw string as-is — every `ZodString` (including
 * constrained formats: `uuid`, `email`, `min`, `regex`…), a string literal, a
 * string enum, a template literal, and any wrapper/union over one of those.
 */
function acceptsRawString(schema: z.core.$ZodType): boolean {
  const type = schema._zod.def.type;
  if (type === 'string' || type === 'template_literal') return true;
  if (schema instanceof z.ZodLiteral) {
    return schema.def.values.some((value) => typeof value === 'string');
  }
  if (schema instanceof z.ZodEnum) {
    return schema.options.some((value) => typeof value === 'string');
  }
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault
  ) {
    return acceptsRawString(schema.unwrap());
  }
  if (schema instanceof z.ZodUnion) {
    return schema.def.options.some((option) => acceptsRawString(option));
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
  // A union with ANY string-typed member owns its string semantics — the rule
  // is decided by the MEMBER, not by whether this particular value validates.
  // Parsing JSON first would silently change identifiers such as `"123"` or
  // `"null"` into another union branch; a constrained member (`uuid`, `email`,
  // `min`) must not weaken the rule. The trade-off is deliberate: in
  // `union([string, array])` a double-serialized `'["a"]'` stays a string and
  // fails loudly downstream instead of a real identifier being corrupted.
  if (typeof current === 'string' && needsJsonCoercion(schema)) {
    if (acceptsRawString(schema)) return current;
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
 * only — it never rebuilds a schema, so it cannot alter what an object does with
 * an undeclared key (→ ADR 0034).
 */
export function coerceJsonArgs(
  args: Record<string, unknown>,
  schema: z.ZodType | undefined,
): Record<string, unknown> {
  const coerced = coerceValue(args, schema);
  return isRecord(coerced) ? coerced : args;
}
