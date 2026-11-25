import { errnoOf } from '../internal/errno';
import { messageOf } from '../internal/error-message';
import { assertPositiveSafeInteger } from '../internal/positive-integer';
import {
  DEFAULT_JSON_FILE_BYTES,
  decodeJsonText,
  type JsonValueRefusal,
  type JsonValueSchema,
  parseJsonText,
  RegularFileError,
  type RegularFileReadOptions,
  type RegularFileRefusal,
  readRegularFileWithMetaSync,
  validateJsonValue,
} from './regular-file';

/**
 * Explicit outcome of reading a JSON file without throwing: `missing` (absent),
 * `unreadable` (the operating system or a file rule refused the read), `invalid` (the
 * bytes were read and are not the value) and `read` (validated content).
 */
export type JsonFileReading<T> =
  | { readonly state: 'missing' }
  | {
      readonly state: 'unreadable';
      readonly detail: string;
      /** Present when a file rule refused it (`not-regular`, `symbolic-link`, `rejected`, …); absent for an error of the operating system. */
      readonly reason?: Exclude<RegularFileRefusal, JsonValueRefusal>;
    }
  | { readonly state: 'invalid'; readonly reason: JsonValueRefusal; readonly detail: string }
  | { readonly state: 'read'; readonly text: string; readonly value: T };

const VALUE_REFUSALS: ReadonlySet<RegularFileRefusal> = new Set([
  'encoding',
  'syntax',
  'schema',
]);

function isValueRefusal(reason: RegularFileRefusal): reason is JsonValueRefusal {
  return VALUE_REFUSALS.has(reason);
}

/** A failed read as a reading: `missing` for `ENOENT`, `unreadable` otherwise. */
export function failedReadingOf<T>(error: unknown): JsonFileReading<T> {
  if (errnoOf(error) === 'ENOENT') return { state: 'missing' };
  const detail = messageOf(error) || String(error);
  if (error instanceof RegularFileError && !isValueRefusal(error.reason)) {
    return { state: 'unreadable', detail, reason: error.reason };
  }
  return { state: 'unreadable', detail };
}

function invalidOf<T>(error: unknown): JsonFileReading<T> {
  if (error instanceof RegularFileError && isValueRefusal(error.reason)) {
    return { state: 'invalid', reason: error.reason, detail: error.message };
  }
  throw error;
}

/** Strict UTF-8 text of `bytes`, or the `invalid` reading with reason `encoding`. */
export function decodedOf<T>(
  bytes: Uint8Array,
): { readonly text: string } | { readonly failure: JsonFileReading<T> } {
  try {
    return { text: decodeJsonText(bytes) };
  } catch (error) {
    return { failure: invalidOf(error) };
  }
}

/** `text` parsed and validated: `read`, or `invalid` with reason `syntax` or `schema`. */
export function valueReadingOf<T>(
  text: string,
  schema: JsonValueSchema<T>,
): JsonFileReading<T> {
  try {
    return { state: 'read', text, value: validateJsonValue(parseJsonText(text), schema) };
  } catch (error) {
    return invalidOf(error);
  }
}

/** True when both readings are the same failure: one state, reason and detail. */
export function sameFailure<T>(
  previous: JsonFileReading<T> | undefined,
  next: JsonFileReading<T>,
): boolean {
  if (previous === undefined || previous.state !== next.state) return false;
  if (previous.state === 'missing') return true;
  if (previous.state === 'read' || next.state === 'read' || next.state === 'missing')
    return false;
  return previous.detail === next.detail && previous.reason === next.reason;
}

/** Read a JSON file once and classify it as `missing`, `unreadable`, `invalid` or `read`. */
export function readJsonOnce<T>(
  path: string,
  schema: JsonValueSchema<T>,
  options: RegularFileReadOptions = {},
): JsonFileReading<T> {
  assertPositiveSafeInteger('limit', options.limit ?? DEFAULT_JSON_FILE_BYTES);
  let bytes: Uint8Array;
  try {
    bytes = readRegularFileWithMetaSync(path, options).bytes;
  } catch (error) {
    return failedReadingOf(error);
  }
  const decoded = decodedOf<T>(bytes);
  return 'failure' in decoded ? decoded.failure : valueReadingOf(decoded.text, schema);
}
