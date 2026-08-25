/**
 * Payload sanitisation for audit logging — mask secrets, drop binary blobs,
 * cap size. An audit row must be safe to store and bounded in size.
 */
import { isUnsafeKey } from '../internal/safe-json';
import { isRecord } from '../internal/typed';

/** A JSON-serialisable value — what a sanitised payload always reduces to. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Tuning for `redact` / `sanitizePayload`. */
export interface SanitizeOptions {
  /**
   * Keys whose VALUE is masked, tested against the raw key name. When omitted,
   * the default matcher splits the key into words (camelCase, `-`, `_`, spaces)
   * and masks it when a word IS a secret term — so `sessionToken` and
   * `X-Api-Key` are masked while `authorId` and `sessionCount` survive.
   */
  sensitiveKeys?: RegExp;
  /** Cap on the serialised payload — anything larger collapses to a preview. Default 16 KB. */
  maxBytes?: number;
  /** Recursion limit — deeper nesting collapses to a marker. Default 20. */
  maxDepth?: number;
}

/** The result of `measureSize`. */
export interface SizeMeasure {
  /** Item count, when the value is a list (or a `{ items: [] }` page). */
  resultSize: number | null;
  /** Serialised byte length. */
  responseBytes: number;
  /** Set when the value cannot be serialised at all (bigint, a cycle). */
  unserializable?: true;
}

// Any of these appearing as a WHOLE WORD of the key name marks it sensitive.
const SENSITIVE_WORDS = new Set([
  'password',
  'passwords',
  'passwd',
  'pwd',
  'secret',
  'secrets',
  'token',
  'tokens',
  'apikey',
  'auth',
  'authorization',
  'bearer',
  'cookie',
  'cookies',
  'credential',
  'credentials',
]);

// Word PAIRS that only read as a secret together — `api` and `key` are harmless
// alone, `apiKey` / `X-Api-Key` are not. `session` alone stays benign so
// `sessionCount` survives, but a session identifier is a bearer secret.
const SENSITIVE_WORD_PAIRS = new Set([
  'apikey',
  'privatekey',
  'initdata',
  'sessionid',
  'sessionkey',
]);

// The bare key on its own — too ambiguous as a word inside a compound
// (`sessionCount` is a number), unambiguous as the whole name.
const SENSITIVE_EXACT = new Set(['session']);

/**
 * Split a key into lowercase words at camelCase transitions (including
 * acronym runs — `APIKey` → `api`, `key`) and non-alphanumeric separators.
 */
function splitKeyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

/**
 * The default sensitivity test: word-boundary matching, so a key is masked
 * when a secret term is one of its words — never because a benign word merely
 * CONTAINS one (`tokenizer`, `authorized`) and never only on an exact match
 * (`sessionToken`, `dbPassword` must not leak).
 */
function isSensitiveKeyDefault(key: string): boolean {
  const words = splitKeyWords(key);
  if (words.length === 1 && SENSITIVE_EXACT.has(words[0] ?? '')) return true;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? '';
    if (SENSITIVE_WORDS.has(word)) return true;
    const next = words[index + 1];
    if (next !== undefined && SENSITIVE_WORD_PAIRS.has(word + next)) return true;
  }
  return false;
}

const DEFAULT_MAX_BYTES = 16_000;
const DEFAULT_MAX_DEPTH = 20;
const MASK = '[redacted]';

/**
 * Deep-copy `value` into a JSON-safe shape: secret-named keys masked wherever
 * a key exists — object fields and `Map` entries alike, at any depth; a `Set`
 * member has no key and is therefore not masked, binary
 * blobs reduced to `{ _type, size }` metadata, branches past `maxDepth`
 * truncated. Always returns a `JsonValue` — safe to store directly.
 */
export function redact(value: unknown, options: SanitizeOptions = {}): JsonValue {
  const custom = options.sensitiveKeys;
  const isSensitive =
    custom === undefined
      ? isSensitiveKeyDefault
      : (key: string) => {
          custom.lastIndex = 0;
          return custom.test(key);
        };
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

  // Track the ANCESTOR chain of the current node — not every visited object —
  // so a true circular reference collapses to a marker, while a shared (but
  // acyclic) subtree referenced from two siblings is still walked both times.
  const ancestors = new Set<object>();

  const walk = (input: unknown, depth: number): JsonValue => {
    if (depth > maxDepth) return '[max depth]';
    if (input === null || input === undefined) return null;

    if (typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') {
      return input;
    }

    if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
      return { _type: 'binary', size: input.byteLength };
    }
    if (input instanceof Blob) {
      return { _type: 'blob', size: input.size, mime: input.type };
    }
    if (typeof FormData !== 'undefined' && input instanceof FormData) {
      return { _type: 'formdata', keys: [...input.keys()] };
    }
    if (input instanceof Map) {
      if (ancestors.has(input)) return '[circular]';
      ancestors.add(input);
      // A Map HAS keys, so the same rule that masks `{ authorization: … }` has
      // to reach `new Map([['authorization', …]])`. It did not: this branch
      // walked both halves and never asked `isSensitive`, so a handler that
      // collected request headers into a Map — the shape `Headers` naturally
      // becomes — wrote the bearer token into the audit row in cleartext while
      // the identical plain object was masked.
      const result = [...input.entries()].map(([key, value]) => [
        walk(key, depth + 1),
        typeof key === 'string' && isSensitive(key) ? MASK : walk(value, depth + 1),
      ]);
      ancestors.delete(input);
      return { _type: 'map', entries: result };
    }
    if (input instanceof Set) {
      if (ancestors.has(input)) return '[circular]';
      ancestors.add(input);
      // No masking here, and it is not an oversight: a Set has no key, and this
      // masker redacts by KEY NAME. A secret held as a bare Set member is
      // indistinguishable from any other string — the same limit the rest of
      // this module states, said where someone would look for it.
      const values = [...input].map((item) => walk(item, depth + 1));
      ancestors.delete(input);
      return { _type: 'set', values };
    }
    if (input instanceof Error) {
      return {
        _type: 'error',
        name: input.name,
        message: input.message,
        ...(input.stack !== undefined && { stack: input.stack }),
      };
    }

    if (Array.isArray(input)) {
      if (ancestors.has(input)) return '[circular]';
      ancestors.add(input);
      const result = input.map((item) => walk(item, depth + 1));
      ancestors.delete(input);
      return result;
    }

    if (isRecord(input)) {
      if (ancestors.has(input)) return '[circular]';
      ancestors.add(input);
      const out: { [key: string]: JsonValue } = {};
      for (const key of Object.keys(input)) {
        // A `__proto__` key would set the prototype of the produced value.
        if (isUnsafeKey(key)) continue;
        if (isSensitive(key)) {
          out[key] = MASK;
          continue;
        }
        try {
          out[key] = walk(Reflect.get(input, key), depth + 1);
        } catch {
          out[key] = '[unreadable]';
        }
      }
      ancestors.delete(input);
      return out;
    }

    return String(input);
  };

  return walk(value, 0);
}

/**
 * Cap a `JsonValue` by serialised size — anything over `maxBytes` collapses to
 * a `{ _truncated, _originalBytes, preview }` marker.
 */
export function truncatePreview(value: JsonValue, maxBytes = DEFAULT_MAX_BYTES): JsonValue {
  const json = JSON.stringify(value);
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength <= maxBytes) return value;
  // Encode once, cut once: back the boundary off any UTF-8 continuation bytes
  // so the slice holds only complete code points. A surrogate pair is a single
  // 4-byte sequence in UTF-8, so decoding the slice can never produce a lone
  // surrogate — the preview is always well-formed UTF-16.
  let end = Math.max(0, maxBytes);
  while (end > 0 && ((bytes[end] ?? 0) & 0b1100_0000) === 0b1000_0000) end -= 1;
  const preview = new TextDecoder().decode(bytes.subarray(0, end));
  return {
    _truncated: true,
    _originalBytes: bytes.byteLength,
    preview: `${preview}…`,
  };
}

/**
 * Sanitise an arbitrary payload for an audit row — `redact` then
 * `truncatePreview`. `null` / `undefined` reduce to `null`.
 */
export function sanitizePayload(
  value: unknown,
  options: SanitizeOptions = {},
): JsonValue | null {
  if (value === undefined || value === null) return null;
  try {
    return truncatePreview(redact(value, options), options.maxBytes ?? DEFAULT_MAX_BYTES);
  } catch {
    return '[unserializable]';
  }
}

/**
 * Measure a result for the audit row — item count when it is a list (a bare
 * array or a `{ items: [] }` page), and the serialised byte length.
 */
export function measureSize(value: unknown): SizeMeasure {
  if (value === undefined || value === null) {
    return { resultSize: null, responseBytes: 0 };
  }
  let responseBytes = 0;
  try {
    responseBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    // Explicitly distinguishable from an empty result — the row survives with
    // a marker instead of masquerading as "the handler returned nothing".
    return { resultSize: null, responseBytes: 0, unserializable: true };
  }
  if (Array.isArray(value)) {
    return { resultSize: value.length, responseBytes };
  }
  // A cursor-pagination page — `{ items, nextCursor }`. Gate on both keys so a
  // payload that merely happens to carry an `items` array is not miscounted.
  if (isRecord(value) && Array.isArray(value.items) && 'nextCursor' in value) {
    return { resultSize: value.items.length, responseBytes };
  }
  return { resultSize: null, responseBytes };
}
