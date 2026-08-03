import { z } from 'zod';
import { isRecord } from '../internal/typed';
import { toJsonSchema } from './json-schema';
import { type KeyPolicy, keyPolicyOf, rebuildObject, withKeyPolicy } from './schema';

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
 * **Key policy is merged, not dropped.** The flat object stands in for every
 * variant, so it takes the policy that cannot remove what any variant would have
 * kept: every variant `.strict()` → strict (sound, because the flat shape is the
 * union of all variant keys); any variant with a catchall → loose; otherwise
 * plain. A *typed* catchall is never copied onto the flat object — it would
 * reject a sibling variant's differently-typed extra key.
 *
 * **Still lossy:** per-variant strictness (a key legal in variant A and illegal
 * in B) is unrepresentable in one flat object, as are object-level refinements.
 * Those stay enforced only by the original union in `executeToolMethod`. What is
 * *not* lossy any more is deletion — the advertised schema can no longer drop a
 * key the contract would have seen. → ADR 0034.
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
      // A `.default()` is unwrapped for the same reason it must be: every field of
      // the flat object is advertised as optional, so a surviving default would
      // materialise on EVERY call — injecting a non-matching variant's field into
      // the payload, which the real union then rejects as an unrecognized key.
      entry.schemas.push(unwrapField(field));
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
  return withKeyPolicy(z.object(shape), mergeVariantKeyPolicies(union.def.options));
}

/**
 * The key policy for the object that replaces a whole union. One object stands in
 * for variants that may disagree, so it takes the policy that **cannot destroy
 * the evidence** the original union needs to judge the call:
 * - every variant `.strict()` → strict. Sound: the flat shape is the union of all
 *   variant keys, so it only rejects a key no variant declares.
 * - no variant strict → plain. Strips exactly as every variant would.
 * - **mixed, or any variant that keeps unknown keys** (`.loose()`,
 *   `.catchall(T)`) → loose. Plain would *delete* the very key a strict sibling
 *   exists to reject: the flat object cannot tell which variant the caller meant,
 *   so it must forward the key and let the real union decide. A typed catchall is
 *   widened rather than copied — variants may type the same extra key differently.
 */
function mergeVariantKeyPolicies(options: readonly z.core.$ZodType[]): KeyPolicy {
  let strict = 0;
  let counted = 0;
  for (const option of options) {
    const policy = option instanceof z.ZodObject ? keyPolicyOf(option) : undefined;
    // A variant that keeps unknown keys forces loose — never delete what it kept.
    if (policy !== undefined && !(policy instanceof z.ZodNever)) return z.unknown();
    counted++;
    if (policy instanceof z.ZodNever) strict++;
  }
  if (counted === 0 || strict === 0) return undefined;
  return strict === counted ? z.never() : z.unknown();
}

/** The inner type of a variant field — optionality and defaults are not merged. */
function unwrapField(field: z.core.$ZodType): z.core.$ZodType {
  if (field instanceof z.ZodOptional || field instanceof z.ZodDefault) {
    return unwrapField(field.unwrap());
  }
  return field;
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
 * Whether a schema carries any `checks` **at any depth** — including a `.refine()`
 * / custom check / `.pipe()` output that is **invisible** in JSON Schema, so two
 * such fields can normalize equal yet validate differently. The check is deep
 * (recurses through wrappers, object fields, array items, pipe sides) because a
 * hidden constraint nested below the kept node leaks just as badly as one on it.
 * A collided key whose kept schema returns true is widened to `z.unknown()`
 * rather than advertised verbatim, so a refinement from one variant can never
 * reject another variant's valid value. Erring toward `unknown` is invariant-safe
 * (only looser advertising).
 */
function hasChecks(schema: z.core.$ZodType): boolean {
  if (!(schema instanceof z.ZodType)) return false;
  const def: unknown = schema.def;
  if (isRecord(def) && Array.isArray(def.checks) && def.checks.length > 0) return true;

  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault
  ) {
    return hasChecks(schema.unwrap());
  }
  if (schema instanceof z.ZodPipe)
    return hasChecks(schema.def.in) || hasChecks(schema.def.out);
  if (schema instanceof z.ZodObject) return Object.values(schema.shape).some(hasChecks);
  if (schema instanceof z.ZodArray) return hasChecks(schema.element);
  if (schema instanceof z.ZodUnion) return schema.def.options.some(hasChecks);
  if (schema instanceof z.ZodRecord) return hasChecks(schema.valueType);
  if (schema instanceof z.ZodIntersection) {
    return hasChecks(schema.def.left) || hasChecks(schema.def.right);
  }
  return false;
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
    // non-serializable check (`.refine()`, a `.pipe()` output, a nested refine)
    // that holds for only one variant — widen so it cannot reject another
    // variant's valid value (the union still validates it). `hasChecks` is deep.
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
 * untouched rather than crashing the mount (→ ADR 0033).
 *
 * Every object is rebuilt **with its key policy** (`rebuildObject`) — the walk
 * changes union shape, never what an object does with an undeclared key. → ADR 0034.
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
    // `rebuildObject`, not `z.object` — the rebuilt object is what the SDK parses
    // arguments with, so dropping the source's key policy would silently delete
    // keys the contract schema would have rejected or kept. → ADR 0034.
    return preserveDescription(schema, rebuildObject(schema, shape));
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
