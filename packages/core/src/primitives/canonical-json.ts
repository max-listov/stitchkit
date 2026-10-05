import { z } from 'zod';
import { serializeCanonicalJson } from '../internal/canonical-json';
import { type CanonicalJsonRefusal, jsonDataRefusal } from '../internal/json-data';

export type { CanonicalJsonRefusal };

const CanonicalJsonOptionsSchema = z.strictObject({
  maxDepth: z.number().int().min(0).max(100).default(100),
  maxNodes: z.number().int().positive().default(100_000),
  maxBytes: z
    .number()
    .int()
    .positive()
    .default(1024 * 1024),
});
/**
 * Size limits for `canonicalJson` (`maxDepth`, `maxNodes`, `maxBytes`); a value over any limit
 * is refused, not truncated.
 */
export type CanonicalJsonOptions = z.input<typeof CanonicalJsonOptionsSchema>;

const MESSAGES: Record<CanonicalJsonRefusal, string> = {
  cycle: 'Value contains a cycle',
  'negative-zero': 'Value contains -0, which JSON cannot carry',
  depth: 'Value is nested deeper than maxDepth',
  nodes: 'Value has more nodes than maxNodes',
  bytes: 'Value is longer than maxBytes in UTF-8',
  'not-json':
    'Expected bounded plain JSON: dense arrays, finite numbers, plain objects, no accessors',
};

/**
 * A `TypeError` whose `reason` tells an exceeded limit from a value that is not JSON.
 */
export class CanonicalJsonError extends TypeError {
  constructor(readonly reason: CanonicalJsonRefusal) {
    super(MESSAGES[reason]);
    this.name = 'CanonicalJsonError';
  }
}

/**
 * Bounded plain JSON, UTF-16 sorted keys; undefined object members are omitted.
 * Refuses with a {@link CanonicalJsonError}.
 */
export function canonicalJson(value: unknown, options: CanonicalJsonOptions = {}): string {
  return serialize(value, options, false);
}

/**
 * {@link canonicalJson} reading the value as `z.json()` does, for the agent
 * store: model output may carry `-0`, which is JSON-equal to `0`, and the
 * digests of stored events were taken with that reading. Internal.
 */
export function canonicalZodJson(value: unknown, options: CanonicalJsonOptions = {}): string {
  return serialize(value, options, true);
}

function serialize(value: unknown, options: CanonicalJsonOptions, zodJson: boolean): string {
  const limits = CanonicalJsonOptionsSchema.parse(options);
  const snapshot: { value?: unknown } = {};
  const refusal = jsonDataRefusal(
    value,
    { ...limits, omitObjectUndefined: true, zodJson },
    snapshot,
  );
  if (refusal !== undefined) throw new CanonicalJsonError(refusal);
  return serializeCanonicalJson(snapshot.value);
}
