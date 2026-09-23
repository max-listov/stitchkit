import { isRecord } from './typed';

/**
 * UTF-16 code-unit order — the order `Array.prototype.sort` uses without a
 * comparator, and deliberately not code-point or locale order.
 *
 * Locale order would make a digest depend on the machine it ran on. Code-point
 * order would be defensible, but every digest this package has ever written —
 * CLI manifest signatures, agent-store event and checkpoint hashes, archives,
 * committed surface snapshots — was taken in code-unit order, and the two
 * disagree on keys outside the Basic Multilingual Plane. Changing it would
 * report drift in data that never changed.
 */
export function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * The text of one value, or `undefined` where `JSON.stringify` would leave a
 * member out (`undefined`, a function, a symbol).
 *
 * Built as a string rather than by copying keys into a sorted object: an
 * engine lists integer-like keys (`"9"`, `"10"`) first and in numeric order
 * whatever order they were inserted in, so a sorted copy handed to
 * `JSON.stringify` comes back unsorted exactly for them — and the agent store's
 * hashes and archives, which predate this module, were always sorted.
 */
function canonicalText(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return `[${Array.from(value, (item) => canonicalText(item) ?? 'null').join(',')}]`;
  }
  if (!isRecord(value)) return JSON.stringify(value);
  const members: string[] = [];
  for (const key of Object.keys(value).sort(compareCodeUnits)) {
    const text = canonicalText(value[key]);
    if (text !== undefined) members.push(`${JSON.stringify(key)}:${text}`);
  }
  return `{${members.join(',')}}`;
}

/**
 * Canonical bytes for a JSON value — object keys sorted, array order kept.
 *
 * The one serialisation behind every digest and identity in the package: the
 * surface snapshot and the MCP catalog stamp, CLI manifest signatures, the
 * agent store's hashes and archives, watched-read and MCP-round argument keys,
 * and schema comparison in union flattening. Two implementations of "the same
 * bytes" would eventually disagree, and a fingerprint that disagrees with
 * itself reports drift that never happened.
 *
 * What `JSON.stringify` drops or transforms is dropped or transformed here too:
 * an `undefined` member disappears, a `Date` becomes `{}` (its own keys, none). A caller that must
 * refuse such values validates before calling (the agent store parses with
 * `z.json()` first). A top-level `undefined` answers `'undefined'`, so the
 * result is always a string.
 */
export function serializeCanonicalJson(value: unknown): string {
  return canonicalText(value) ?? 'undefined';
}
