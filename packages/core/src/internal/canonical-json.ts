import { isRecord } from './typed';

/**
 * Codepoint order, not locale order.
 *
 * `Array.prototype.sort` without a comparator is codepoint order already, but
 * `localeCompare` is what a reader reaches for — and it would make a digest
 * depend on the machine's locale, which is the one input a fingerprint must
 * never have.
 */
export function compareCodepoints(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort(compareCodepoints)) {
    result[key] = canonicalValue(value[key]);
  }
  return result;
}

/**
 * Canonical bytes for a JSON value — object keys sorted, array order kept.
 *
 * The single serialisation behind every digest this repository takes of a
 * declared surface: the committed manifest snapshot and the live MCP catalog
 * stamp. Two implementations of "the same bytes" would eventually disagree,
 * and a fingerprint that disagrees with itself reports drift that never
 * happened.
 */
export function serializeCanonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}
