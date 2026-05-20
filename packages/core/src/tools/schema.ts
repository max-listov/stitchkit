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
  if (typeof val === 'string') {
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  }
  return val;
};

export function withJsonCoercion(
  schema: z.ZodObject<z.ZodRawShape>,
): z.ZodObject<z.ZodRawShape> {
  const shape = schema.shape;
  const coerced: Record<string, z.core.$ZodType> = {};

  for (const [key, field] of Object.entries(shape)) {
    if (!needsJsonCoercion(field)) {
      coerced[key] = field;
      continue;
    }

    let inner: z.core.$ZodType = field;
    const wrappers: ('optional' | 'nullable')[] = [];
    while (inner instanceof z.ZodOptional || inner instanceof z.ZodNullable) {
      if (inner instanceof z.ZodOptional) {
        wrappers.push('optional');
        inner = inner.unwrap();
      } else {
        wrappers.push('nullable');
        inner = inner.unwrap();
      }
    }
    let result: z.core.$ZodType = z.preprocess(jsonCoerce, inner);
    for (const wrapper of wrappers.reverse()) {
      result = wrapper === 'optional' ? z.optional(result) : z.nullable(result);
    }
    coerced[key] = result;
  }
  return z.object(coerced);
}

function flattenDiscriminatedUnion(
  union: z.ZodDiscriminatedUnion,
): z.ZodObject<z.ZodRawShape> {
  const discriminator = union.def.discriminator;

  const literalValues: string[] = [];
  const fieldToVariants = new Map<string, string[]>();
  const fieldSchemas: Record<string, z.core.$ZodType> = {};

  for (const opt of union.def.options) {
    if (!(opt instanceof z.ZodObject)) {
      throw new Error(
        `flattenDiscriminatedUnion: option for discriminator '${discriminator}' is not a ZodObject`,
      );
    }
    const discField = opt.shape[discriminator];
    if (!(discField instanceof z.ZodLiteral)) {
      throw new Error(
        `flattenDiscriminatedUnion: discriminator field '${discriminator}' must be z.literal()`,
      );
    }
    const [literalValue] = discField.def.values;
    if (typeof literalValue !== 'string') {
      throw new Error(
        `flattenDiscriminatedUnion: discriminator literal must be a string (got ${typeof literalValue})`,
      );
    }
    literalValues.push(literalValue);

    for (const [key, field] of Object.entries(opt.shape)) {
      if (key === discriminator) continue;
      const variants = fieldToVariants.get(key) ?? [];
      variants.push(literalValue);
      fieldToVariants.set(key, variants);
      if (!(key in fieldSchemas)) {
        fieldSchemas[key] = field instanceof z.ZodOptional ? field : z.optional(field);
      }
    }
  }

  const [firstLiteral, ...restLiterals] = literalValues;
  if (!firstLiteral) {
    throw new Error('flattenDiscriminatedUnion: union has no options');
  }

  const shape: Record<string, z.core.$ZodType> = {
    [discriminator]: z.enum([firstLiteral, ...restLiterals]),
  };
  for (const [key, field] of Object.entries(fieldSchemas)) {
    const variants = fieldToVariants.get(key) ?? [];
    const hint = `Required if ${discriminator} = ${variants.join(' | ')}`;
    shape[key] = field instanceof z.ZodType ? field.describe(hint) : field;
  }
  return z.object(shape);
}

export function mergeSchemas(
  paramsSchema?: z.ZodType<unknown>,
  inputSchema?: z.ZodType<unknown>,
): z.ZodObject<z.ZodRawShape> {
  const paramsShape = paramsSchema instanceof z.ZodObject ? paramsSchema.shape : {};

  const inputShape =
    inputSchema instanceof z.ZodObject
      ? inputSchema.shape
      : inputSchema instanceof z.ZodDiscriminatedUnion
        ? flattenDiscriminatedUnion(inputSchema).shape
        : {};

  const paramsKeys = Object.keys(paramsShape);
  const inputKeys = new Set(Object.keys(inputShape));
  const conflicts = paramsKeys.filter((k) => inputKeys.has(k));
  if (conflicts.length > 0) {
    throw new Error(
      `Schema merge conflict: ${conflicts.join(', ')} appear in both params and input`,
    );
  }

  const merged = { ...paramsShape, ...inputShape };
  if (Object.keys(merged).length === 0) return z.object({});
  return withJsonCoercion(z.object(merged));
}
