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

/** Copy a `.describe()` description from `from` onto a rebuilt schema `to`. */
function preserveDescription(from: z.ZodType, to: z.ZodType): z.ZodType {
  return from.description === undefined ? to : to.describe(from.description);
}

/**
 * Recursively flatten **every** `ZodDiscriminatedUnion` in a schema — at the top
 * level and nested inside object fields, array items and `optional` / `nullable`
 * / `default` / intersection wrappers — so the advertised JSON Schema carries no
 * `oneOf` / `anyOf` at any depth. `flattenDiscriminatedUnion` alone is shallow
 * (it copies a variant's fields verbatim), so a nested union — e.g.
 * `content.parts[]` being an array of a discriminated union — would otherwise
 * still reach the transport as `oneOf`, which weaker models mishandle.
 *
 * Like the single-level flatten this is **lossy and advertised-only**: the
 * original schemas remain the validation schemas in `executeToolMethod`. Schemas
 * a transform cannot safely rebuild (refined / piped / lazy / plain non-
 * discriminated unions) are left untouched — a discriminated union behind one of
 * those keeps its `oneOf`.
 */
export function flattenUnionsDeep(schema: z.core.$ZodType): z.ZodType {
  // Concrete zod schemas all extend the `z.ZodType` runtime base — narrow the
  // abstract spec type the introspected sub-schemas (object fields, array
  // elements, unwrapped inners) carry. Unreachable for a real schema.
  if (!(schema instanceof z.ZodType)) return z.unknown();

  if (schema instanceof z.ZodDiscriminatedUnion) {
    // Flatten this level, then recurse into the produced object's fields — a
    // variant field may itself contain a nested union.
    return preserveDescription(schema, flattenUnionsDeep(flattenDiscriminatedUnion(schema)));
  }
  if (schema instanceof z.ZodObject) {
    const shape: Record<string, z.core.$ZodType> = {};
    for (const [key, field] of Object.entries(schema.shape)) {
      shape[key] = flattenUnionsDeep(field);
    }
    return preserveDescription(schema, z.object(shape));
  }
  if (schema instanceof z.ZodArray) {
    return preserveDescription(schema, z.array(flattenUnionsDeep(schema.element)));
  }
  if (schema instanceof z.ZodOptional) {
    return preserveDescription(schema, z.optional(flattenUnionsDeep(schema.unwrap())));
  }
  if (schema instanceof z.ZodNullable) {
    return preserveDescription(schema, z.nullable(flattenUnionsDeep(schema.unwrap())));
  }
  if (schema instanceof z.ZodDefault) {
    return preserveDescription(
      schema,
      flattenUnionsDeep(schema.unwrap()).default(schema.def.defaultValue),
    );
  }
  if (schema instanceof z.ZodIntersection) {
    return preserveDescription(
      schema,
      z.intersection(flattenUnionsDeep(schema.def.left), flattenUnionsDeep(schema.def.right)),
    );
  }
  return schema;
}
