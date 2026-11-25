import { type ZodObject, z } from 'zod';
import { isRecord } from '../../internal/typed';

function containsLocalRef(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsLocalRef);
  if (!isRecord(value)) return false;
  return typeof value.$ref === 'string' || Object.values(value).some(containsLocalRef);
}

interface UnpackedRootObject {
  base?: ZodObject;
  guards: z.core.$ZodType[];
  metas: z.GlobalMeta[];
  needsStrictPatternCheck: boolean;
}

function unpackRootObject(
  schema: z.core.$ZodType,
  visited: ReadonlySet<z.core.$ZodType> = new Set(),
): UnpackedRootObject | undefined {
  const ownMeta = z.globalRegistry.get(schema);
  const metas = ownMeta ? [ownMeta] : [];
  if (schema instanceof z.ZodObject) {
    return { base: schema, guards: [], metas: [], needsStrictPatternCheck: false };
  }
  if (schema instanceof z.ZodPipe) {
    if (!(schema.in instanceof z.ZodTransform)) return undefined;
    const inner = unpackRootObject(schema.out, visited);
    if (!inner) return undefined;
    return {
      ...inner,
      guards: [schema.in, ...inner.guards],
      metas: [...inner.metas, ...metas],
    };
  }
  if (schema instanceof z.ZodRecord) {
    return { base: undefined, guards: [schema], metas, needsStrictPatternCheck: false };
  }
  if (schema instanceof z.ZodIntersection) {
    const left = unpackRootObject(schema.def.left, visited);
    const right = unpackRootObject(schema.def.right, visited);
    if (!left || !right) return undefined;
    const guards = [...left.guards, ...right.guards];
    const base = left.base ?? right.base;
    if (left.base && right.base) guards.push(right.base);
    return {
      base,
      guards,
      metas: [...left.metas, ...right.metas, ...metas],
      needsStrictPatternCheck:
        left.needsStrictPatternCheck ||
        right.needsStrictPatternCheck ||
        Boolean(schema.def.checks?.length),
    };
  }
  if (schema instanceof z.ZodReadonly) {
    const inner = unpackRootObject(schema.unwrap(), visited);
    return inner ? { ...inner, metas: [...inner.metas, ...metas] } : undefined;
  }
  if (schema instanceof z.ZodLazy) {
    if (visited.has(schema)) return undefined;
    const nextVisited = new Set(visited);
    nextVisited.add(schema);
    const inner = unpackRootObject(schema.unwrap(), nextVisited);
    return inner ? { ...inner, metas: [...inner.metas, ...metas] } : undefined;
  }
  return undefined;
}

/**
 * Recover a `ZodObject` from any valid object root produced by `z.fromJSONSchema`
 * (`ZodObject`, `ZodPipe(ZodTransform, inner)`, `ZodIntersection`, `ZodRecord`,
 * `ZodReadonly`, `ZodLazy`), preserving `.shape`, `required`, metadata, and
 * original Zod issues for `localVerdict`.
 */
export function toRootZodObject(
  parsed: z.ZodType,
  joined: Record<string, unknown>,
): ZodObject | undefined {
  if (parsed instanceof z.ZodObject) return parsed;
  const unpacked = unpackRootObject(parsed);
  if (!unpacked) return undefined;
  let result: ZodObject = unpacked.base ?? z.looseObject({});
  const patternProps = isRecord(joined.patternProperties)
    ? joined.patternProperties
    : undefined;
  const strictPatterns =
    unpacked.needsStrictPatternCheck &&
    joined.additionalProperties === false &&
    patternProps !== undefined
      ? Object.keys(patternProps).map((pattern) => new RegExp(pattern))
      : undefined;

  if (unpacked.guards.length > 0 || strictPatterns !== undefined) {
    const propertyKeys = new Set(Object.keys(result.shape));
    const guards = unpacked.guards;
    result = result.superRefine((value, ctx) => {
      for (const guard of guards) {
        const checked = z.safeParse(guard, value);
        if (!checked.success) {
          for (const issue of checked.error.issues) {
            const raw: Record<string, unknown> = {};
            ctx.addIssue(Object.assign(raw, issue));
          }
        }
      }
      if (strictPatterns !== undefined) {
        const unrecognized = Object.keys(value).filter(
          (key) => !propertyKeys.has(key) && !strictPatterns.some((regex) => regex.test(key)),
        );
        if (unrecognized.length > 0) {
          ctx.addIssue({
            code: 'unrecognized_keys',
            keys: unrecognized,
            input: value,
            message: `Unrecognized key${unrecognized.length > 1 ? 's' : ''}: ${unrecognized.map((k) => JSON.stringify(k)).join(', ')}`,
          });
        }
      }
    });
  }

  const mergedMeta: z.GlobalMeta = {};
  for (const meta of unpacked.metas) Object.assign(mergedMeta, meta);
  if (patternProps !== undefined && !containsLocalRef(patternProps)) {
    mergedMeta.patternProperties = patternProps;
    if (joined.additionalProperties === false) mergedMeta.additionalProperties = false;
  }
  if (Object.keys(mergedMeta).length > 0) result = result.meta(mergedMeta);
  return result;
}
