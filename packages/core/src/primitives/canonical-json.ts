import { z } from 'zod';
import { serializeCanonicalJson } from '../internal/canonical-json';
import { isJsonData } from '../internal/json-data';

const CanonicalJsonOptionsSchema = z.strictObject({
  maxDepth: z.number().int().min(0).max(100).default(100),
  maxNodes: z.number().int().positive().default(100_000),
  maxBytes: z
    .number()
    .int()
    .positive()
    .default(1024 * 1024),
});
export type CanonicalJsonOptions = z.input<typeof CanonicalJsonOptionsSchema>;

/** Bounded plain JSON, UTF-16 sorted keys; undefined object members are omitted. */
export function canonicalJson(value: unknown, options: CanonicalJsonOptions = {}): string {
  const limits = CanonicalJsonOptionsSchema.parse(options);
  const snapshot: { value?: unknown } = {};
  if (!isJsonData(value, { ...limits, omitObjectUndefined: true }, snapshot))
    throw new TypeError(
      'Expected bounded plain JSON: dense arrays, finite numbers, no -0, cycles or accessors',
    );
  return serializeCanonicalJson(snapshot.value);
}
