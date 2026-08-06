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
 * A collided key whose kept schema returns true keeps its base type
 * rather than advertised verbatim, so a refinement from one variant can never
 * reject another variant's valid value. Erring toward `unknown` is invariant-safe
 * (only looser advertising).
 */
function hasInvisibleConstraint(schema: z.core.$ZodType): boolean {
  if (!(schema instanceof z.ZodType)) return false;
  const def: unknown = schema.def;

  // A node JSON Schema cannot express at all (`z.custom()`, `z.date()`,
  // `z.bigint()`, `z.map()`…) converts to `{}`, so every constraint on it is
  // invisible — including ones whose *kind* looks serializable.
  if (isRecord(def) && def.type !== 'unknown' && def.type !== 'any') {
    if (normalizedJson(schema) === '{}') return true;
  }
  // `.catch()` swallows a parse failure and substitutes a value, so the real
  // schema accepts strictly more than its JSON says. Advertising it verbatim
  // would be narrower than the variant it came from.
  if (schema instanceof z.ZodCatch) return true;
  // Coercion is not serialized: `z.coerce.number()` and `z.number()` are
  // byte-identical in JSON and accept different value sets.
  if (isRecord(def) && def.coerce === true) return true;

  if (isRecord(def) && Array.isArray(def.checks)) {
    for (const check of def.checks) {
      if (isInvisibleCheck(check)) return true;
    }
  }

  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault
  ) {
    return hasInvisibleConstraint(schema.unwrap());
  }
  // A pipe's *output* is never serialized (`io: 'input'`), so any constraint on
  // it is invisible however ordinary its kind looks.
  if (schema instanceof z.ZodPipe) return true;
  if (schema instanceof z.ZodObject) {
    return Object.values(schema.shape).some(hasInvisibleConstraint);
  }
  if (schema instanceof z.ZodArray) return hasInvisibleConstraint(schema.element);
  if (schema instanceof z.ZodUnion) return schema.def.options.some(hasInvisibleConstraint);
  if (schema instanceof z.ZodRecord) return hasInvisibleConstraint(schema.valueType);
  if (schema instanceof z.ZodIntersection) {
    return hasInvisibleConstraint(schema.def.left) || hasInvisibleConstraint(schema.def.right);
  }
  return false;
}

/**
 * Check kinds whose effect never reaches JSON Schema. `custom` is `.refine()` /
 * `.superRefine()`; `overwrite` is `.trim()` / `.toLowerCase()` / `.normalize()`,
 * which are worse than a rejection — they **change the value** on its way to a
 * handler that never asked for it.
 *
 * Read from `_zod.def.check`: the top-level `.check` property is the check
 * *function*, and comparing that to a string is silently always false.
 */
const INVISIBLE_CHECK_KINDS = new Set(['custom', 'overwrite']);

/**
 * A node that accepts **more** than its own type keyword says — coercion turns
 * `"1"` into a number, `.catch()` swallows any failure and substitutes. For
 * these the base type is not a superset but a *narrowing*: advertising `number`
 * would reject a string the variant happily takes. They are the one case where
 * `z.unknown()` is still the honest answer.
 */
function acceptsMoreThanItsType(schema: z.core.$ZodType): boolean {
  if (!(schema instanceof z.ZodType)) return false;
  if (schema instanceof z.ZodCatch) return true;
  if (isRecord(schema.def) && schema.def.coerce === true) return true;
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault
  ) {
    return acceptsMoreThanItsType(schema.unwrap());
  }
  // A pipe's input side is what the caller sends; a `z.preprocess` widens it.
  if (schema instanceof z.ZodPipe) return acceptsMoreThanItsType(schema.def.in);
  return false;
}

function isInvisibleCheck(check: unknown): boolean {
  if (!isRecord(check)) return false;
  const inner: unknown = check._zod;
  const def: unknown = isRecord(inner) ? inner.def : undefined;
  const kind: unknown = isRecord(def) ? def.check : undefined;
  return typeof kind === 'string' && INVISIBLE_CHECK_KINDS.has(kind);
}

/**
 * The advertised schema for a field whose own constraints cannot be trusted
 * across variants: its **base type**, and nothing else.
 *
 * This is the difference between "the model is told nothing" and "the model is
 * told it is a number". A collided field is by definition a field every variant
 * declared, so the type is the one thing provably shared — and a bare type is a
 * superset of every variant by construction, which is what the invariant needs
 * (→ ADR 0033). Widening all the way to `z.unknown()` throws that away for
 * nothing. → ADR 0044.
 */
function projectToBaseType(schema: z.core.$ZodType): z.core.$ZodType {
  if (!(schema instanceof z.ZodType)) return z.unknown();
  // Nullability is part of the accepted set, not a constraint on it: dropping it
  // would advertise a rejection of `null` that no variant makes. Optionality is
  // re-applied by the caller (`z.optional` at the field site); `null` is not.
  if (schema instanceof z.ZodNullable) {
    return z.nullable(projectToBaseType(schema.unwrap()));
  }
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    return projectToBaseType(schema.unwrap());
  }
  // The advertised truth about a pipe is its input side — the only side
  // `io: 'input'` ever serialized.
  if (schema instanceof z.ZodPipe) return projectToBaseType(schema.def.in);
  // `.catch()` accepts anything and substitutes; no type is honest here.
  if (schema instanceof z.ZodCatch) return z.unknown();
  // Coercion is kept, not dropped: a coercing base still advertises the type
  // keyword AND still accepts what the variant accepts, so it is the honest
  // projection rather than a narrowing.
  const coerces = isRecord(schema.def) && schema.def.coerce === true;
  if (schema instanceof z.ZodNumber) return coerces ? z.coerce.number() : z.number();
  if (schema instanceof z.ZodString) return coerces ? z.coerce.string() : z.string();
  if (schema instanceof z.ZodBoolean && coerces) return z.coerce.boolean();
  // A string enum or literal is a string. Saying so costs nothing and is the
  // difference between an enum-vs-free-string collision advertising `string`
  // and advertising nothing at all.
  if (schema instanceof z.ZodEnum || schema instanceof z.ZodLiteral) {
    return stringLiteralOrEnumValues(schema) === null ? z.unknown() : z.string();
  }
  if (schema instanceof z.ZodBoolean) return z.boolean();
  if (schema instanceof z.ZodArray) return z.array(z.unknown());
  // Loose, never strict: an advertised object must not delete a key a variant
  // keeps. → ADR 0034.
  if (schema instanceof z.ZodObject) return z.looseObject({});
  return z.unknown();
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
 * - otherwise → the shared base type if the variants agree on one, else
 *   `z.unknown()` (the original union still validates the real shape).
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
    // One JSON shape across ≥2 variants still proves only that the constraints
    // **JSON can express** are identical. A `.refine()`, a pipe's output side, a
    // `.trim()`, a node JSON cannot represent at all — each holds for one variant
    // and is invisible here. Where one is present the field cannot be advertised
    // verbatim; it is advertised as its base type, which is looser than every
    // variant rather than blank. `hasInvisibleConstraint` is deep.
    if (schemas.length <= 1) return only;
    // Scan **every** variant, not just the one that happened to be kept. The
    // whole branch exists for constraints JSON cannot show, so a hazard on a
    // sibling is exactly as invisible — and reading only `values[0]` would make
    // the answer depend on the order the variants were declared in.
    // An accept-more hazard forces `unknown` only when the variants **disagree**
    // about it. All coercing (or all `.catch()`) is the shape they share, and
    // advertising it verbatim is exactly what happened before this rule existed —
    // blanking it would trade a useful type for no type and fix nothing.
    const hazards = schemas.map(acceptsMoreThanItsType);
    if (hazards.some(Boolean) && !hazards.every(Boolean)) return z.unknown();
    if (schemas.some(hasInvisibleConstraint)) {
      // A node JSON Schema cannot represent has always failed the mount loudly
      // (`probeSchema`). Projecting it would convert cleanly and ship a blank
      // property instead — a silent version of a caught error.
      if (normalizedJson(only) === '{}') return only;
      return projectToBaseType(only);
    }
    return only;
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

  // The variants disagree on more than their values — different constraints on
  // the same kind (`min(0)` vs `min(5)`), an enum against a free string, two
  // differently-shaped objects. They can still agree on the **kind**, and that
  // is worth advertising: a field that is a number in every variant must not
  // reach the model blank just because the variants bound it differently.
  // Project each to its base type; if they all land on the same one, that is the
  // shared truth. Kinds that genuinely differ stay `unknown` — JSON Schema could
  // say `"type": ["string", "number"]`, but no Zod node emits that and inventing
  // one is a separate decision. → ADR 0044.
  const hazards = schemas.map(acceptsMoreThanItsType);
  if (hazards.some(Boolean) && !hazards.every(Boolean)) return z.unknown();
  const projected = values.map(projectToBaseType);
  const first = projected[0];
  if (first !== undefined) {
    const shape = normalizedJson(first);
    if (shape !== '{}' && projected.every((p) => normalizedJson(p) === shape)) return first;
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
