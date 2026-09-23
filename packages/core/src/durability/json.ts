import { z } from 'zod';

/** Reject serialization that would coerce, omit or execute user-defined behavior. */
function losslessJson(value: unknown, ancestors = new Set<object>(), depth = 0): boolean {
  if (depth > 100) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (
    array
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null
  )
    return false;
  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (array && keys.length !== value.length + 1) return false;
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') return false;
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))
        return false;
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !('value' in descriptor)) return false;
      if (!losslessJson(descriptor.value, ancestors, depth + 1)) return false;
    }
    return true;
  } finally {
    ancestors.delete(value);
  }
}

export const DurableJsonSchema = z.custom<z.infer<ReturnType<typeof z.json>>>(
  (value) => losslessJson(value),
  'Expected lossless JSON data (finite numbers, plain objects and dense arrays; no accessors)',
);
