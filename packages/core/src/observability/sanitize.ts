/**
 * Payload sanitisation for audit logging — mask secrets, drop binary blobs,
 * cap size. An audit row must be safe to store and bounded in size.
 */
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
  /** Keys whose VALUE is masked. Default covers passwords, tokens, secrets… */
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
}

const DEFAULT_SENSITIVE_KEYS =
  /(password|passwd|pwd|secret|token|apikey|api[-_ ]?key|auth|authorization|bearer|session|cookie|init[-_ ]?data|credential|private[-_ ]?key)/i;

const DEFAULT_MAX_BYTES = 16_000;
const DEFAULT_MAX_DEPTH = 20;
const MASK = '[redacted]';

/**
 * Deep-copy `value` into a JSON-safe shape: secret-named keys masked, binary
 * blobs reduced to `{ _type, size }` metadata, branches past `maxDepth`
 * truncated. Always returns a `JsonValue` — safe to store directly.
 */
export function redact(value: unknown, options: SanitizeOptions = {}): JsonValue {
  const sensitive = options.sensitiveKeys ?? DEFAULT_SENSITIVE_KEYS;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

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

    if (Array.isArray(input)) {
      return input.map((item) => walk(item, depth + 1));
    }

    if (isRecord(input)) {
      const out: { [key: string]: JsonValue } = {};
      for (const [key, val] of Object.entries(input)) {
        out[key] = sensitive.test(key) ? MASK : walk(val, depth + 1);
      }
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
  if (json.length <= maxBytes) return value;
  return {
    _truncated: true,
    _originalBytes: json.length,
    preview: `${json.slice(0, maxBytes)}…`,
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
  return truncatePreview(redact(value, options), options.maxBytes ?? DEFAULT_MAX_BYTES);
}

/**
 * Measure a result for the audit row — item count when it is a list (a bare
 * array or a `{ items: [] }` page), and the serialised byte length.
 */
export function measureSize(value: unknown): SizeMeasure {
  if (value === undefined || value === null) {
    return { resultSize: null, responseBytes: 0 };
  }
  const responseBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (Array.isArray(value)) {
    return { resultSize: value.length, responseBytes };
  }
  if (typeof value === 'object' && 'items' in value && Array.isArray(value.items)) {
    return { resultSize: value.items.length, responseBytes };
  }
  return { resultSize: null, responseBytes };
}
