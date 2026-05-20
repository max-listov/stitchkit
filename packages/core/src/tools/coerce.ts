import { z } from 'zod';

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

const jsonCoerce = (val: unknown) => {
  if (typeof val !== 'string') return val;
  try {
    return JSON.parse(val);
  } catch {
    return val;
  }
};

/**
 * Wrap array/object fields with `z.preprocess(jsonCoerce)` — tolerant of
 * LLM double-serialization (sending `"[1,2]"` instead of `[1,2]`).
 * Preserves optional/nullable wrappers so the emitted JSON Schema is identical.
 */
export function withJsonCoercion(
  schema: z.ZodObject<z.ZodRawShape>,
): z.ZodObject<z.ZodRawShape> {
  const shape = schema.shape;
  const coerced: Record<string, z.core.$ZodType> = {};

  for (const key of Object.keys(shape)) {
    const field = shape[key];
    if (!field || !needsJsonCoercion(field)) {
      if (field) coerced[key] = field;
      continue;
    }

    let inner: z.core.$ZodType = field;
    const wrappers: ('optional' | 'nullable')[] = [];
    while (inner instanceof z.ZodOptional || inner instanceof z.ZodNullable) {
      wrappers.push(inner instanceof z.ZodOptional ? 'optional' : 'nullable');
      inner = inner.unwrap();
    }
    let result: z.core.$ZodType = z.preprocess(jsonCoerce, inner);
    for (const wrapper of wrappers.reverse()) {
      result = wrapper === 'optional' ? z.optional(result) : z.nullable(result);
    }
    coerced[key] = result;
  }

  return z.object(coerced);
}
