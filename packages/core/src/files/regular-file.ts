import { constants, openSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { z } from 'zod';
import {
  BoundedFileReadError,
  isNonRegularOpenErrno,
  readBoundedFileFrom,
  readBoundedFileSync,
} from '../internal/bounded-file-read';
import { errnoOf } from '../internal/errno';
import { messageOf } from '../internal/error-message';
import type {
  FileIdentityStats,
  FileReadDescriptor,
  FileReadStat,
  FileStatsView,
  NanosecondFileStats,
} from '../internal/file-observation';
import { assertPositiveSafeInteger } from '../internal/positive-integer';
import { isUnsafeKey } from '../internal/safe-json';
import { formatZodError } from '../internal/zod-issues';

/** Default byte cap for reading JSON configuration and state files (1 MiB). */
export const DEFAULT_JSON_FILE_BYTES = 1024 * 1024;

const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });

/**
 * Metadata check run on the open descriptor before any byte is read. The file is read
 * only when it returns `true`: anything else — `false`, a forgotten `return` — refuses
 * it with `RegularFileError` reason `rejected`; throwing refuses it with that error.
 */
export type RegularFileAccept = (info: FileStatsView) => boolean;

/** Byte cap, `noFollow` and the descriptor `accept` check of a regular-file read. */
export interface RegularFileReadOptions {
  /** Byte cap; default {@link DEFAULT_JSON_FILE_BYTES}. */
  limit?: number;
  /**
   * Open with `O_NOFOLLOW`: a symbolic link as the last path component is refused,
   * not followed. Links in the directories above it are still followed, so a caller
   * that distrusts them checks or owns the directory.
   */
  noFollow?: boolean;
  /** Metadata check on the descriptor the bytes are read from (owner, mode, link count). */
  accept?: RegularFileAccept;
}

/** The regular-file read options plus cancellation for the async read. */
export interface RegularFileAsyncReadOptions extends RegularFileReadOptions {
  signal?: AbortSignal;
}

/**
 * Why a read was refused. The file: `not-regular` (directory, FIFO, socket, device),
 * `too-large` (over `limit`), `symbolic-link` (under `noFollow`), `rejected` (by
 * `accept`), `unsupported` (`noFollow` on a platform without `O_NOFOLLOW`), `changed`
 * (the file kept changing across a read and its single retry). Its bytes, which are
 * not the expected value: `encoding` (not strict UTF-8), `syntax` (not JSON, or JSON
 * with a `__proto__` key), `schema` (the schema refused or threw). The original
 * failure is the error's `cause`; a refusal of the operating system (`ENOENT`,
 * `EACCES`, `EIO`) is not a `RegularFileError` and keeps its own `code`.
 */
export type RegularFileRefusal =
  | 'not-regular'
  | 'too-large'
  | 'symbolic-link'
  | 'rejected'
  | 'unsupported'
  | 'changed'
  | 'encoding'
  | 'syntax'
  | 'schema';

/** The refusals of bytes that were read but are not the expected value. */
export type JsonValueRefusal = Extract<RegularFileRefusal, 'encoding' | 'syntax' | 'schema'>;

/** Thrown when a path cannot be read as a stable regular file; `reason` says which rule refused it. */
export class RegularFileError extends Error {
  readonly reason: RegularFileRefusal;

  constructor(reason: RegularFileRefusal, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RegularFileError';
    this.reason = reason;
  }
}

/**
 * Minimal schema contract satisfied by every Zod schema (`z.ZodType<T>`) as
 * well as lightweight custom validators.
 */
export interface JsonValueSchema<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: unknown };
}

/**
 * Stable metadata identity of a file snapshot (`dev:ino:size:mtime:ctime`),
 * using nanosecond resolution when given `fs.BigIntStats` and millisecond floats
 * when given standard `fs.Stats`.
 */
export function fileIdentity(info: FileIdentityStats): string {
  const mtime = 'mtimeNs' in info ? String(info.mtimeNs) : String(info.mtimeMs);
  const ctime = 'ctimeNs' in info ? String(info.ctimeNs) : String(info.ctimeMs);
  return `${info.dev}:${info.ino}:${info.size}:${mtime}:${ctime}`;
}

/** Internal fast-stat cache key extending `fileIdentity` with `mode`, `uid`, `gid` and `nlink`. */
export function fileCacheIdentity(
  info: FileIdentityStats & {
    mode: number | bigint;
    uid: number | bigint;
    gid: number | bigint;
    nlink: number | bigint;
  },
): string {
  return `${fileIdentity(info)}:${info.mode}:${info.uid}:${info.gid}:${info.nlink}`;
}

/** Decode bytes strictly as UTF-8, refusing malformed sequences instead of substituting U+FFFD. */
export function decodeUtf8Strict(bytes: Uint8Array): string {
  return UTF8_STRICT.decode(bytes);
}

/** Human-readable detail for a schema failure, preserving Zod issue paths when available. */
export function formatSchemaError(error: unknown): string {
  if (error instanceof z.ZodError) return formatZodError(error);
  const message = messageOf(error);
  return message || String(error);
}

function assertNoFollowAvailable(path: string, noFollow: boolean | undefined): void {
  if (noFollow && constants.O_NOFOLLOW === undefined) {
    throw new RegularFileError(
      'unsupported',
      `noFollow is unavailable on this platform: ${path}`,
    );
  }
}

function acceptCheck<S extends FileStatsView>(
  accept: RegularFileAccept | undefined,
  path: string,
): ((info: S) => void) | undefined {
  if (accept === undefined) return undefined;
  return (info) => {
    if (accept(info) !== true) {
      throw new RegularFileError('rejected', `File rejected by metadata check: ${path}`);
    }
  };
}

/**
 * One translation of the descriptor reader's refusals for the sync and async reads,
 * each naming the path. `changed` is returned rather than thrown: the caller retries once.
 */
function refusalOf(error: unknown, path: string, limit: number): RegularFileError | undefined {
  if (error instanceof RegularFileError) return error;
  if (error instanceof BoundedFileReadError) {
    const options = { cause: error };
    switch (error.code) {
      case 'FILE_CHANGED':
        return new RegularFileError('changed', `File changed while reading: ${path}`, options);
      case 'FILE_UNSAFE_LINK':
        return new RegularFileError(
          'symbolic-link',
          `Symbolic link refused: ${path}`,
          options,
        );
      case 'FILE_TOO_LARGE':
        return new RegularFileError(
          'too-large',
          `File exceeds ${limit}-byte limit: ${path}`,
          options,
        );
      case 'FILE_UNSUPPORTED':
        return new RegularFileError(
          'unsupported',
          `noFollow is unavailable on this platform: ${path}`,
          options,
        );
      case 'FILE_NOT_REGULAR':
        return new RegularFileError('not-regular', `Not a regular file: ${path}`, options);
    }
  }
  if (isNonRegularOpenErrno(errnoOf(error))) {
    return new RegularFileError('not-regular', `Not a regular file: ${path}`, {
      cause: error,
    });
  }
  return undefined;
}

/** The refusal to retry on (`changed`), after rethrowing every other failure. */
function retryOn(error: unknown, path: string, limit: number): RegularFileError {
  const refusal = refusalOf(error, path, limit);
  if (refusal === undefined) throw error;
  if (refusal.reason !== 'changed') throw refusal;
  return refusal;
}

/** Two attempts; a file that changes during both is refused as `changed`. */
function withOneRetry<T>(path: string, limit: number, attempt: () => T): T {
  try {
    return attempt();
  } catch (error) {
    retryOn(error, path, limit);
  }
  try {
    return attempt();
  } catch (error) {
    throw retryOn(error, path, limit);
  }
}

/**
 * Synchronous regular-file read returning both bytes and the descriptor's exact
 * post-read `fstat`, so callers like `PolledJsonFile` can cache without a second
 * `stat` race. `openFd` lets a test act between the open and the checks.
 */
export function readRegularFileWithMetaSync(
  path: string,
  options: RegularFileReadOptions = {},
  openFd: (target: string, flags: number) => number = openSync,
): { bytes: Uint8Array; after: NanosecondFileStats } {
  const { limit = DEFAULT_JSON_FILE_BYTES, noFollow, accept } = options;
  assertPositiveSafeInteger('limit', limit);
  assertNoFollowAvailable(path, noFollow);
  const inspect = acceptCheck(accept, path);
  return withOneRetry(path, limit, () => {
    const { bytes, after } = readBoundedFileSync(
      path,
      limit,
      { stable: true, rejectSymlinks: noFollow, inspect },
      openFd,
    );
    return { bytes, after };
  });
}

/**
 * Synchronously read a regular file opened with `O_RDONLY | O_NONBLOCK` (never
 * hangs on a FIFO), enforcing `limit`, `noFollow`, the descriptor `accept`
 * check, and before/after identity stability with one retry.
 */
export function readRegularFileSync(
  path: string,
  options?: RegularFileReadOptions,
): Uint8Array {
  return readRegularFileWithMetaSync(path, options).bytes;
}

type RegularFileStat = FileReadStat & FileStatsView;

/**
 * Async regular-file reader backed by the bounded descriptor reader, with an
 * injectable opener for deterministic concurrency and abort tests.
 */
export async function readRegularFileFromOpen(
  path: string,
  options: RegularFileAsyncReadOptions = {},
  openDescriptor: (
    target: string,
    flags: number,
  ) => Promise<FileReadDescriptor<RegularFileStat>> = open,
): Promise<Uint8Array> {
  const { limit = DEFAULT_JSON_FILE_BYTES, noFollow, accept, signal } = options;
  assertPositiveSafeInteger('limit', limit);
  assertNoFollowAvailable(path, noFollow);
  const inspect = acceptCheck<RegularFileStat>(accept, path);
  const attempt = async () => {
    signal?.throwIfAborted();
    const read = await readBoundedFileFrom(
      path,
      limit,
      { stable: true, signal, rejectSymlinks: noFollow, inspect },
      openDescriptor,
    );
    return read.bytes;
  };
  try {
    return await attempt();
  } catch (error) {
    retryOn(error, path, limit);
  }
  try {
    return await attempt();
  } catch (error) {
    throw retryOn(error, path, limit);
  }
}

/**
 * Asynchronously read a regular file opened with `O_RDONLY | O_NONBLOCK`,
 * enforcing `limit`, `noFollow`, the descriptor `accept` check, `signal`
 * cancellation, and before/after stability with one retry.
 */
export function readRegularFile(
  path: string,
  options?: RegularFileAsyncReadOptions,
): Promise<Uint8Array> {
  return readRegularFileFromOpen(path, options);
}

function refuseValue(
  reason: JsonValueRefusal,
  what: string,
  detail: string,
  path: string | undefined,
  cause: unknown,
): RegularFileError {
  const where = path === undefined ? '' : ` for ${path}`;
  return new RegularFileError(reason, `${what}${where}: ${detail}`, { cause });
}

/** Strict UTF-8 text of `bytes`, or `RegularFileError` reason `encoding`. */
export function decodeJsonText(bytes: Uint8Array, path?: string): string {
  try {
    return decodeUtf8Strict(bytes);
  } catch (error) {
    throw refuseValue('encoding', 'Not strict UTF-8', messageOf(error), path, error);
  }
}

class UnsafeKeyError extends Error {
  constructor() {
    super('the key "__proto__" is refused');
    this.name = 'UnsafeKeyError';
  }
}

/**
 * JSON value of `text`, or `RegularFileError` reason `syntax`. A `__proto__` key at
 * any depth is refused rather than dropped: a reader of a strict schema never sees a
 * value the file did not hold.
 */
export function parseJsonText(text: string, path?: string): unknown {
  try {
    return JSON.parse(text, (key, value: unknown) => {
      if (isUnsafeKey(key)) throw new UnsafeKeyError();
      return value;
    });
  } catch (error) {
    throw refuseValue('syntax', 'Not JSON', messageOf(error), path, error);
  }
}

/** `raw` validated by `schema`, or `RegularFileError` reason `schema` (refused or thrown). */
export function validateJsonValue<T>(
  raw: unknown,
  schema: JsonValueSchema<T>,
  path?: string,
): T {
  let parsed: ReturnType<JsonValueSchema<T>['safeParse']>;
  try {
    parsed = schema.safeParse(raw);
  } catch (error) {
    // A schema that throws (a throwing transform) refuses the value like one that fails.
    throw refuseValue('schema', 'Schema validation failed', messageOf(error), path, error);
  }
  if (!parsed.success) {
    throw refuseValue(
      'schema',
      'Schema validation failed',
      formatSchemaError(parsed.error),
      path,
      parsed.error,
    );
  }
  return parsed.data;
}

/**
 * Decode bytes as strict UTF-8 and parse them as JSON; `RegularFileError` reason
 * `encoding` or `syntax` (a `__proto__` key included) otherwise.
 */
export function parseJsonBytes(bytes: Uint8Array): unknown {
  return parseJsonText(decodeJsonText(bytes));
}

/**
 * Synchronously read a regular JSON file within `limit`, decode strict UTF-8, and
 * validate against a Zod or `{ safeParse }` schema. Bytes that are not the value
 * throw `RegularFileError` reason `encoding`, `syntax` or `schema` with the original
 * failure as `cause`.
 */
export function readJsonFileSync<T>(
  path: string,
  schema: JsonValueSchema<T>,
  options?: RegularFileReadOptions,
): T {
  const bytes = readRegularFileSync(path, options);
  return validateJsonValue(parseJsonText(decodeJsonText(bytes, path), path), schema, path);
}
