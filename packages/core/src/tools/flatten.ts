import { z } from 'zod';
import { isRecord } from '../internal/typed';
import { toJsonSchema } from './json-schema';

/**
 * Flatten a `ZodDiscriminatedUnion` into a single `ZodObject` for LLM transports
 * that cannot represent `oneOf` (MCP / weaker models).
 *
 * The discriminator becomes a `z.enum(...)` of **all** variant values; each
 * variant's fields become optional with a `.describe()` hint naming the variants
 * that require them. When two variants declare the **same key with different
 * shapes**, the advertised field is widened so it accepts every variant's value —
 * never narrowed to one (which would make the losing variant unsatisfiable):
 *
 * - identical across variants → kept as-is.
 * - all string literal/enum → merged into one widened `z.enum`.
 * - otherwise (object vs array, differing object shapes) → `z.unknown()` (accepts
 *   anything; the `.describe()` carries the per-variant shape).
 *
 * This keeps the advertised schema free of `oneOf` / `anyOf` at any depth (→ ADR
 * 0033) **and** a superset of the original union, so a model can always produce a
 * value that passes both the transport SDK and validation.
 *
 * **Lossy and advertised-only:** the original union remains the validation schema
 * in `executeToolMethod`. `.strict()` / `.catchall()` / object-level refinements
 * on variants are dropped from the *advertised* hint (validation still enforces
 * them — see ADR 0033 on the strict-variant caveat).
 */
export function flattenDiscriminatedUnion(
  union: z.ZodDiscriminatedUnion,
): z.ZodObject<z.ZodRawShape> {
  const discriminator = union.def.discriminator;
  const allDiscValues: string[] = [];
  const perKey = new Map<string, { schemas: z.core.$ZodType[]; variants: string[] }>();

  for (const opt of union.def.options) {
    if (!(opt instanceof z.ZodObject)) {
      throw new Error(
        `flattenDiscriminatedUnion: variant for discriminator '${discriminator}' is not a ZodObject`,
      );
    }
    const discValues = stringLiteralOrEnumValues(opt.shape[discriminator]);
    if (discValues === null) {
      throw new Error(
        `flattenDiscriminatedUnion: discriminator '${discriminator}' must be a string z.literal() or z.enum()`,
      );
    }
    allDiscValues.push(...discValues);
    const label = discValues.join(' | ');

    for (const [key, field] of Object.entries(opt.shape)) {
      if (key === discriminator) continue;
      const entry = perKey.get(key) ?? { schemas: [], variants: [] };
      // Compare/merge the inner type — a field's optionality is re-applied below.
      entry.schemas.push(field instanceof z.ZodOptional ? field.unwrap() : field);
      entry.variants.push(label);
      perKey.set(key, entry);
    }
  }

  const uniqDisc = [...new Set(allDiscValues)];
  const [firstLiteral, ...restLiterals] = uniqDisc;
  if (firstLiteral === undefined) {
    throw new Error('flattenDiscriminatedUnion: union has no options');
  }

  const shape: Record<string, z.core.$ZodType> = {
    [discriminator]: z.enum([firstLiteral, ...restLiterals]),
  };
  for (const [key, entry] of perKey) {
    const advertised = mergeCollidingFields(entry.schemas);
    const hint = `Required if ${discriminator} = ${[...new Set(entry.variants)].join(' | ')}`;
    shape[key] = z.optional(advertised).describe(hint);
  }
  return z.object(shape);
}

/** Copy a `.describe()` description from `from` onto a rebuilt schema `to`. */
function preserveDescription(from: z.ZodType, to: z.ZodType): z.ZodType {
  return from.description === undefined ? to : to.describe(from.description);
}

/** All string values of a literal (incl. multi-value) / enum field, or `null` if
 *  it is not a string-valued literal/enum. */
function stringLiteralOrEnumValues(field: z.core.$ZodType): string[] | null {
  let raw: readonly unknown[] | null = null;
  if (field instanceof z.ZodLiteral) raw = field.def.values;
  else if (field instanceof z.ZodEnum) raw = field.options;
  if (raw === null) return null;
  const strings = raw.filter((v): v is string => typeof v === 'string');
  return strings.length === raw.length ? strings : null;
}

/** True if a discriminated union can be safely flattened — every variant is a
 *  `ZodObject` and the discriminator is a string literal/enum. */
function isFlattenableDU(union: z.ZodDiscriminatedUnion): boolean {
  const disc = union.def.discriminator;
  if (union.def.options.length === 0) return false;
  for (const opt of union.def.options) {
    if (!(opt instanceof z.ZodObject)) return false;
    if (stringLiteralOrEnumValues(opt.shape[disc]) === null) return false;
  }
  return true;
}

/** Remove JSON-Schema annotation keys so two structurally-equal fields compare
 *  equal regardless of per-variant `.describe()` / `.default()`. */
function stripAnnotations(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) stripAnnotations(item);
    return;
  }
  if (typeof node === 'object' && node !== null) {
    Reflect.deleteProperty(node, 'description');
    Reflect.deleteProperty(node, 'default');
    Reflect.deleteProperty(node, '$schema');
    for (const value of Object.values(node)) stripAnnotations(value);
  }
}

/**
 * Whether a schema carries any `checks` — including a `.refine()` / custom check
 * that is **invisible** in JSON Schema, so two such fields can normalize equal
 * yet validate differently. A collided key whose kept schema has checks is
 * therefore widened to `z.unknown()` rather than advertised verbatim, so a
 * refinement from one variant cannot reject another variant's valid value.
 */
function hasChecks(schema: z.core.$ZodType): boolean {
  if (!(schema instanceof z.ZodType)) return false;
  const def: unknown = schema.def;
  return isRecord(def) && Array.isArray(def.checks) && def.checks.length > 0;
}

/** A normalized (annotation-stripped) JSON-Schema string for de-duping fields. */
function normalizedJson(schema: z.core.$ZodType): string {
  if (!(schema instanceof z.ZodType)) return '{}';
  const json = toJsonSchema(schema, 'input', 'any');
  stripAnnotations(json);
  return JSON.stringify(json);
}

/**
 * Merge the schemas a single key carries across variants into ONE advertised
 * field that accepts every variant's value (superset), without emitting
 * `oneOf` / `anyOf`:
 * - one distinct type → keep it.
 * - all string literal/enum → one widened `z.enum`.
 * - otherwise → `z.unknown()` (the original union still validates the real shape).
 */
function mergeCollidingFields(schemas: z.core.$ZodType[]): z.core.$ZodType {
  const distinct = new Map<string, z.core.$ZodType>();
  for (const schema of schemas) {
    const key = normalizedJson(schema);
    if (!distinct.has(key)) distinct.set(key, schema);
  }
  const values = [...distinct.values()];
  const only = values[0];
  if (values.length <= 1) {
    if (only === undefined) return z.unknown();
    // A single distinct JSON shape across ≥2 variants can still hide a
    // non-serializable `.refine()` that holds for only one variant — widen so it
    // cannot reject another variant's valid value (the union still validates it).
    return schemas.length > 1 && hasChecks(only) ? z.unknown() : only;
  }

  const merged: string[] = [];
  let allEnum = true;
  for (const schema of values) {
    const vals = stringLiteralOrEnumValues(schema);
    if (vals === null) {
      allEnum = false;
      break;
    }
    merged.push(...vals);
  }
  if (allEnum) {
    const uniq = [...new Set(merged)];
    const [first, ...rest] = uniq;
    if (first !== undefined) return z.enum([first, ...rest]);
  }
  return z.unknown();
}

/**
 * Recursively flatten **every** flattenable `ZodDiscriminatedUnion` in a schema —
 * top level and nested inside object fields, array items, plain unions, records,
 * and `optional` / `nullable` / `default` / intersection wrappers — so the
 * advertised JSON Schema carries no `oneOf` / `anyOf` at any depth. A union that
 * cannot be flattened (non-string discriminator, non-object variant) is left
 * untouched rather than crashing the mount (→ ADR 0033). Advertised-only; the
 * original schemas remain the validation schemas.
 */
export function flattenUnionsDeep(schema: z.core.$ZodType): z.ZodType {
  if (!(schema instanceof z.ZodType)) return z.unknown();

  // Must precede ZodUnion — a discriminated union is also a ZodUnion.
  if (schema instanceof z.ZodDiscriminatedUnion) {
    if (!isFlattenableDU(schema)) return schema;
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
  if (schema instanceof z.ZodUnion) {
    // Plain (non-discriminated) union — cannot be flattened, but recurse into its
    // members so a discriminated union nested inside one still flattens.
    const opts = schema.def.options.map((option) => flattenUnionsDeep(option));
    const [a, b, ...rest] = opts;
    return a && b ? preserveDescription(schema, z.union([a, b, ...rest])) : schema;
  }
  if (schema instanceof z.ZodRecord) {
    return preserveDescription(
      schema,
      z.record(schema.keyType, flattenUnionsDeep(schema.valueType)),
    );
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
