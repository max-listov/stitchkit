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
  /** Augment, rather than replace, the built-in sensitive-key matcher. */
  includeDefaultSensitiveKeys?: boolean;
  /** Dot paths to mask. `*` matches one segment and `**` matches any suffix. */
  sensitivePaths?: readonly string[];
  /** Patterns whose matching portions are masked in every string, including messages. */
  sensitiveUrlPatterns?: readonly RegExp[];
  /** Cap on the serialised payload — anything larger collapses to a preview. Default 16 KB. */
  maxBytes?: number;
  /** Recursion limit — deeper nesting collapses to a marker. Default 20. */
  maxDepth?: number;
  /** Maximum UTF-16 string length before an explicit truncation marker. */
  maxStringLength?: number;
  /** Maximum members retained from an array, map, set, or object. */
  maxCollectionLength?: number;
  /**
   * Maximum values visited in one walk. The ancestor check stops cycles, not
   * a shared acyclic subtree reached from many parents — a diamond-shaped
   * object of a few hundred keys can mean billions of visits — so past this
   * budget the rest collapses to a marker. Default 20 000.
   */
  maxNodes?: number;
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
const DEFAULT_MAX_NODES = 20_000;
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
          return (
            custom.test(key) ||
            (options.includeDefaultSensitiveKeys === true && isSensitiveKeyDefault(key))
          );
        };
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxStringLength = options.maxStringLength ?? Number.POSITIVE_INFINITY;
  const maxCollectionLength = options.maxCollectionLength ?? Number.POSITIVE_INFINITY;
  const pathMatchers = (options.sensitivePaths ?? []).map((pattern) => pattern.split('.'));
  const matchesPath = (
    matcher: readonly string[],
    path: readonly string[],
    patternIndex = 0,
    pathIndex = 0,
  ): boolean => {
    if (patternIndex === matcher.length) return pathIndex === path.length;
    const segment = matcher[patternIndex];
    if (segment === '**') {
      if (patternIndex + 1 === matcher.length) return true;
      for (let next = pathIndex; next <= path.length; next += 1) {
        if (matchesPath(matcher, path, patternIndex + 1, next)) return true;
      }
      return false;
    }
    if (pathIndex === path.length || (segment !== '*' && segment !== path[pathIndex]))
      return false;
    return matchesPath(matcher, path, patternIndex + 1, pathIndex + 1);
  };
  const isSensitivePath = (path: readonly string[]): boolean =>
    pathMatchers.some((matcher) => matchesPath(matcher, path));
  const safeString = (input: string): string => {
    let output = input;
    for (const pattern of options.sensitiveUrlPatterns ?? []) {
      try {
        // Rebuilt as global and never sticky: a `y` flag would mask only a
        // match at position 0 and leave every later secret in place.
        const global = new RegExp(pattern.source, `${pattern.flags.replace(/[gy]/g, '')}g`);
        output = output.replace(global, MASK);
      } catch {
        // A consumer regexp must not turn diagnostics into application failure.
      }
    }
    if (output.length <= maxStringLength) return output;
    return `${output.slice(0, Math.max(0, maxStringLength))}…[truncated]`;
  };

  // Track the ANCESTOR chain of the current node — not every visited object —
  // so a true circular reference collapses to a marker, while a shared (but
  // acyclic) subtree referenced from two siblings is still walked both times.
  const ancestors = new Set<object>();

  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  let visited = 0;
  const walk = (input: unknown, depth: number, path: readonly string[] = []): JsonValue => {
    if (depth > maxDepth) return '[max depth]';
    visited += 1;
    if (visited > maxNodes) return '[node budget]';
    if (input === null || input === undefined) return null;

    if (typeof input === 'string') return safeString(input);
    if (typeof input === 'number' || typeof input === 'boolean') {
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
      const entries = [...input.entries()];
      const result = entries.slice(0, maxCollectionLength).map(([key, value]) => {
        const segment = typeof key === 'string' ? key : String(key);
        const childPath = [...path, segment];
        return [
          walk(key, depth + 1, [...path, '[key]']),
          (typeof key === 'string' && isSensitive(key)) || isSensitivePath(childPath)
            ? MASK
            : walk(value, depth + 1, childPath),
        ];
      });
      if (entries.length > maxCollectionLength)
        result.push(['[truncated]', entries.length - maxCollectionLength]);
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
      const entries = [...input];
      const values = entries
        .slice(0, maxCollectionLength)
        .map((item, index) => walk(item, depth + 1, [...path, String(index)]));
      if (entries.length > maxCollectionLength)
        values.push(`[truncated ${entries.length - maxCollectionLength} items]`);
      ancestors.delete(input);
      return { _type: 'set', values };
    }
    if (input instanceof Date) {
      return Number.isNaN(input.getTime()) ? '[invalid date]' : input.toISOString();
    }
    if (input instanceof URL) return safeString(input.href);
    if (input instanceof Error) {
      const property = (name: 'name' | 'message' | 'stack' | 'cause'): unknown => {
        try {
          return Reflect.get(input, name);
        } catch {
          return '[unreadable]';
        }
      };
      const stack = property('stack');
      const cause = property('cause');
      return {
        _type: 'error',
        name: safeString(String(property('name'))),
        message: safeString(String(property('message'))),
        ...(stack !== undefined && { stack: safeString(String(stack)) }),
        ...(cause !== undefined && { cause: walk(cause, depth + 1, [...path, 'cause']) }),
      };
    }

    if (Array.isArray(input)) {
      if (ancestors.has(input)) return '[circular]';
      ancestors.add(input);
      const result: JsonValue[] = [];
      const count = Math.min(input.length, maxCollectionLength);
      for (let index = 0; index < count; index += 1) {
        try {
          result.push(walk(Reflect.get(input, index), depth + 1, [...path, String(index)]));
        } catch {
          result.push('[unreadable]');
        }
      }
      if (input.length > maxCollectionLength)
        result.push(`[truncated ${input.length - maxCollectionLength} items]`);
      ancestors.delete(input);
      return result;
    }

    if (isRecord(input)) {
      if (ancestors.has(input)) return '[circular]';
      ancestors.add(input);
      const out: { [key: string]: JsonValue } = {};
      const keys = Object.keys(input);
      for (const key of keys.slice(0, maxCollectionLength)) {
        // A `__proto__` key would set the prototype of the produced value.
        if (isUnsafeKey(key)) continue;
        const childPath = [...path, key];
        if (isSensitive(key) || isSensitivePath(childPath)) {
          out[key] = MASK;
          continue;
        }
        try {
          out[key] = walk(Reflect.get(input, key), depth + 1, childPath);
        } catch {
          out[key] = '[unreadable]';
        }
      }
      // Bracketed like the array and map markers, so it cannot shadow a real
      // `_truncated` property of the value being logged.
      if (keys.length > maxCollectionLength)
        out['[truncated]'] = keys.length - maxCollectionLength;
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
