import { z } from 'zod';

/**
 * Flatten a `ZodDiscriminatedUnion` into a single `ZodObject` for LLM
 * transports that cannot represent `oneOf` (MCP).
 *
 * The discriminator becomes a `z.enum(...)` of all variant values; fields
 * from each variant become optional with a `.describe()` hint indicating
 * which variant requires them.
 *
 * **Lossy:** per-variant field requiredness is replaced with optional +
 * description hint. The original union remains the validation schema in
 * `executeToolMethod` — this is the advertised schema only.
 */
export function flattenDiscriminatedUnion(
  union: z.ZodDiscriminatedUnion,
): z.ZodObject<z.ZodRawShape> {
  const discriminator = union.def.discriminator;

  const literalValues: string[] = [];
  const fieldToVariants = new Map<string, string[]>();
  const fieldSchemas: Record<string, z.ZodType> = {};

  for (const opt of union.def.options) {
    if (!(opt instanceof z.ZodObject)) {
      throw new Error(
        `flattenDiscriminatedUnion: variant for discriminator '${discriminator}' is not a ZodObject`,
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
      throw new Error('flattenDiscriminatedUnion: discriminator literal must be a string');
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
    shape[key] = field.describe(hint);
  }
  return z.object(shape);
}
