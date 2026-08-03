import { z } from 'zod';
import { toJsonSchema } from './json-schema';

/** Keys of a Zod object schema's shape — `[]` for a non-object or absent schema. */
export function objectShapeKeys(schema?: z.ZodType): string[] {
  return schema instanceof z.ZodObject ? Object.keys(schema.shape) : [];
}

/**
 * An object schema's own key policy — what it does with a key its shape does not
 * declare. Zod stores it in `def.catchall`: `ZodNever` for `.strict()` (reject),
 * `ZodUnknown` for `.loose()` / `.passthrough()` (keep), a concrete type for
 * `.catchall(T)` (keep and validate), `undefined` for a plain object (strip).
 */
export type KeyPolicy = z.core.$ZodType | undefined;

/** The key policy of an object schema. */
export function keyPolicyOf(schema: z.ZodObject): KeyPolicy {
  return schema.def.catchall;
}

/**
 * Rebuild an object schema with a new shape, **carrying the source object's key
 * policy over**.
 *
 * Load-bearing, not cosmetic: the advertised tool schema is not
 * advertised-only. Both transport SDKs parse the caller's arguments *with it* and
 * hand the handler the parsed result (MCP `validateToolInput` →
 * `parseResult.data`; the AI SDK's `doParseToolCall` → `parseResult.value`), so
 * an object rebuilt as a bare `z.object()` silently **deletes** every key the
 * contract schema would have rejected (`.strict()`) or kept (`.loose()` /
 * `.catchall()`) — the caller gets a success and never learns its argument was
 * wrong. → ADR 0034.
 *
 * A plain source (`undefined` policy) needs no special case: the rebuilt object
 * strips exactly as the contract object would have.
 *
 * A policy JSON Schema cannot represent (`.catchall(z.date())`) degrades to
 * `z.unknown()`: copying it verbatim would fail the mount's JSON Schema probe and
 * take every tool down with it, while dropping it would silently delete data.
 * Loose keeps the invariant — nothing the contract would have kept is removed.
 */
export function rebuildObject(
  source: z.ZodObject,
  shape: Record<string, z.core.$ZodType>,
): z.ZodObject {
  return withKeyPolicy(z.object(shape), keyPolicyOf(source));
}

/** Apply a key policy to a freshly built object, degrading what JSON Schema cannot carry. */
export function withKeyPolicy(
  object: z.ZodObject<z.ZodRawShape>,
  policy: KeyPolicy,
): z.ZodObject {
  if (policy === undefined) return object;
  return object.catchall(representable(policy));
}

/** A catchall JSON Schema can carry — `z.unknown()` when the original cannot be. */
function representable(policy: z.core.$ZodType): z.core.$ZodType {
  if (policy instanceof z.ZodNever || policy instanceof z.ZodUnknown) return policy;
  if (!(policy instanceof z.ZodType)) return z.unknown();
  try {
    toJsonSchema(policy, 'input');
    return policy;
  } catch {
    return z.unknown();
  }
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
 *   `oneOf`). ⚠️ Zod drops both sides' key policy when it intersects objects, so
 *   this branch still strips (MCP rejects a non-object merged schema at mount;
 *   the agent surface does not). → ADR 0034, "Not covered".
 *
 * The merged schema is exactly the two source schemas side by side: nothing is
 * coerced, flattened or transformed, so the schema a tool advertises is the
 * schema its arguments are validated against (`executeToolMethod` parses each
 * source schema over its own slice of the args).
 *
 * The merged object takes the **input** schema's key policy, never the params
 * one. `executeToolMethod` slices the flat args by the params shape's keys and
 * routes *everything else* into the input slice, so a params catchall can never
 * fire (its slice is built from its own shape) while an undeclared top-level key
 * is judged by the input schema. A params-only tool returns the params object
 * untouched, policy included.
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
    return rebuildObject(inputSchema, {
      ...(paramsObject?.shape ?? {}),
      ...inputSchema.shape,
    });
  }

  // Non-object input — a union / discriminated union / refined schema. Kept
  // intact; intersected with params so both are still enforced and advertised.
  return paramsObject ? z.intersection(paramsObject, inputSchema) : inputSchema;
}
