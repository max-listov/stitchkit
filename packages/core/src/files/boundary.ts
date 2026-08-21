import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import {
  ManagedFilePathSchema,
  type ManagedFileRef,
  ManagedFileRefSchema,
} from '../contract/file-ref';
import { isWithinDir } from '../internal/within-dir';

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_INSPECTION_BYTES = 64 * 1024;
const DEFAULT_INSPECTION_TIMEOUT_MS = 15_000;
const NOFOLLOW_FLAG = constants.O_NOFOLLOW ?? 0;
const ManagedFileInspectionSchema = ManagedFileRefSchema.pick({
  mediaType: true,
  name: true,
});

export type ManagedFileErrorCode =
  | 'FILE_INVALID_PATH'
  | 'FILE_NOT_FOUND'
  | 'FILE_NOT_REGULAR'
  | 'FILE_OUTSIDE_ROOT'
  | 'FILE_TOO_LARGE'
  | 'FILE_EXISTS'
  | 'FILE_INSPECTION_REJECTED'
  | 'FILE_IO_ERROR';

export class ManagedFileError extends Error {
  constructor(
    public readonly code: ManagedFileErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ManagedFileError';
  }
}

export interface ManagedFileInspectionInput {
  prefix: Uint8Array;
  declaredMediaType?: string;
  name: string;
  /** Aborts with the caller or the boundary's inspection deadline. */
  signal: AbortSignal;
}

export type ManagedFileInspection = Pick<ManagedFileRef, 'mediaType' | 'name'>;

export type ManagedFileInspector = (
  input: ManagedFileInspectionInput,
) => ManagedFileInspection | Promise<ManagedFileInspection>;

export interface ManagedFileBoundaryConfig {
  /** Directory owned exclusively by the application or trusted OS actor. */
  root: string;
  /** Create the missing final root below an existing trusted parent. Default `false`. */
  createRoot?: boolean;
  maxReadBytes?: number;
  maxWriteBytes?: number;
  inspectionBytes?: number;
  /** Maximum time to wait for a content inspector. Default 15 seconds. */
  inspectionTimeoutMs?: number;
  inspect?: ManagedFileInspector;
  onCleanupError?: (error: unknown) => void;
}

export interface ManagedFileReadOptions {
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface ManagedFileWriteOptions {
  replace?: boolean;
  durable?: boolean;
  maxBytes?: number;
  mediaType?: string;
  name?: string;
  signal?: AbortSignal;
}

export interface ManagedFileSource {
  ref: ManagedFileRef;
  bytes: Uint8Array;
}

export interface ManagedFileBoundary {
  read(path: string, options?: ManagedFileReadOptions): Promise<ManagedFileSource>;
  write(
    path: string,
    source: Uint8Array | ReadableStream<Uint8Array>,
    options?: ManagedFileWriteOptions,
  ): Promise<ManagedFileRef>;
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}

function filePath(path: string): string {
  const parsed = ManagedFilePathSchema.safeParse(path);
  if (!parsed.success) {
    throw new ManagedFileError('FILE_INVALID_PATH', 'invalid managed-file path');
  }
  return parsed.data;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function ioError(message: string, error: unknown): ManagedFileError {
  if (error instanceof ManagedFileError) return error;
  return new ManagedFileError('FILE_IO_ERROR', message, { cause: error });
}

async function realpathOrNull(path: string, message: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw ioError(message, error);
  }
}

async function bindRoot(config: ManagedFileBoundaryConfig): Promise<string> {
  const requested = resolve(config.root);
  let canonical = await realpathOrNull(requested, 'failed to resolve managed-file root');

  if (canonical === null && config.createRoot) {
    const parent = await realpathOrNull(
      dirname(requested),
      'failed to resolve managed-file root parent',
    );
    if (parent === null) {
      throw new ManagedFileError('FILE_NOT_FOUND', 'managed-file root parent must exist');
    }
    const parentInfo = await stat(parent).catch((error: unknown) => {
      throw ioError('failed to inspect managed-file root parent', error);
    });
    if (!parentInfo.isDirectory()) {
      throw new ManagedFileError(
        'FILE_NOT_REGULAR',
        'managed-file root parent must be a directory',
      );
    }

    try {
      // Deliberately not recursive: ownership only extends to this final directory.
      await mkdir(requested, { mode: 0o700 });
    } catch (error) {
      // Another boundary may have won the same bootstrap race. The canonical
      // bind and directory check below decide whether that winner is acceptable.
      if (errorCode(error) !== 'EEXIST') {
        if (errorCode(error) === 'ENOENT') {
          throw new ManagedFileError('FILE_NOT_FOUND', 'managed-file root parent must exist');
        }
        throw ioError('failed to create managed-file root', error);
      }
    }
    canonical = await realpathOrNull(requested, 'failed to resolve managed-file root');
  }

  if (canonical === null) {
    throw new ManagedFileError('FILE_NOT_FOUND', 'managed-file root must exist');
  }
  const info = await stat(canonical).catch((error: unknown) => {
    throw ioError('failed to inspect managed-file root', error);
  });
  if (!info.isDirectory()) {
    throw new ManagedFileError('FILE_NOT_REGULAR', 'managed-file root must be a directory');
  }
  return canonical;
}

async function existingParent(root: string, target: string): Promise<string> {
  const parent = await realpathOrNull(
    dirname(target),
    'failed to resolve managed-file parent directory',
  );
  if (parent === null) {
    throw new ManagedFileError('FILE_NOT_FOUND', 'managed-file parent directory not found');
  }
  if (!isWithinDir(root, parent)) {
    throw new ManagedFileError('FILE_OUTSIDE_ROOT', 'managed-file path escapes its boundary');
  }
  const info = await stat(parent).catch((error: unknown) => {
    throw ioError('failed to inspect managed-file parent directory', error);
  });
  if (!info.isDirectory()) {
    throw new ManagedFileError('FILE_NOT_REGULAR', 'managed-file parent is not a directory');
  }
  return parent;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

function raceWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;
    const settle = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      complete();
    };
    const onAbort = (): void => settle(() => rejectPromise(abortReason(signal)));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    operation.then(
      (value) => settle(() => resolvePromise(value)),
      (error: unknown) => settle(() => rejectPromise(error)),
    );
  });
}

async function inspectFile(
  inspector: ManagedFileInspector | undefined,
  input: Omit<ManagedFileInspectionInput, 'signal'>,
  timeoutMs: number,
  outerSignal?: AbortSignal,
): Promise<ManagedFileInspection> {
  if (!inspector) return {};
  outerSignal?.throwIfAborted();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = outerSignal ? AbortSignal.any([outerSignal, timeoutSignal]) : timeoutSignal;
  try {
    const inspected = await raceWithSignal(
      Promise.resolve().then(() => inspector({ ...input, signal })),
      signal,
    );
    return ManagedFileInspectionSchema.parse(inspected);
  } catch (error) {
    if (outerSignal?.aborted) throw abortReason(outerSignal);
    throw new ManagedFileError(
      'FILE_INSPECTION_REJECTED',
      'managed file rejected by inspection',
      { cause: error },
    );
  }
}

function inspectedRef(
  path: string,
  size: number,
  inspection: ManagedFileInspection,
  fallback: { mediaType?: string; name?: string } = {},
): ManagedFileRef {
  const mediaType = inspection.mediaType ?? fallback.mediaType;
  const name = inspection.name ?? fallback.name;
  const parsed = ManagedFileRefSchema.safeParse({
    path,
    size,
    ...(mediaType ? { mediaType } : {}),
    ...(name ? { name } : {}),
  });
  if (!parsed.success) {
    throw new ManagedFileError(
      'FILE_INSPECTION_REJECTED',
      'managed file rejected by inspection',
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

async function readHandle(
  handle: Awaited<ReturnType<typeof open>>,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    signal?.throwIfAborted();
    const capacity = Math.min(64 * 1024, maxBytes + 1 - total);
    if (capacity <= 0) {
      throw new ManagedFileError('FILE_TOO_LARGE', `file exceeds the ${maxBytes}-byte cap`);
    }
    const chunk = new Uint8Array(capacity);
    const { bytesRead } = await handle.read(chunk, 0, capacity);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) {
      throw new ManagedFileError('FILE_TOO_LARGE', `file exceeds the ${maxBytes}-byte cap`);
    }
    chunks.push(chunk.subarray(0, bytesRead));
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function writeChunk(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
    if (bytesWritten === 0) throw new Error('zero-byte managed-file write');
    offset += bytesWritten;
  }
}

async function writeSource(
  handle: Awaited<ReturnType<typeof open>>,
  source: Uint8Array | ReadableStream<Uint8Array>,
  maxBytes: number,
  inspectionBytes: number,
  signal?: AbortSignal,
): Promise<{ size: number; prefix: Uint8Array }> {
  let size = 0;
  const prefixChunks: Uint8Array[] = [];
  let prefixSize = 0;
  const consume = async (chunk: Uint8Array): Promise<void> => {
    signal?.throwIfAborted();
    size += chunk.byteLength;
    if (size > maxBytes) {
      throw new ManagedFileError('FILE_TOO_LARGE', `file exceeds the ${maxBytes}-byte cap`);
    }
    if (prefixSize < inspectionBytes) {
      const kept = chunk.subarray(0, inspectionBytes - prefixSize);
      prefixChunks.push(kept);
      prefixSize += kept.byteLength;
    }
    await writeChunk(handle, chunk);
  };

  if (source instanceof Uint8Array) {
    await consume(source);
  } else {
    const reader = source.getReader();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        await consume(result.value);
      }
    } catch (error) {
      await reader.cancel(error).catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  const prefix = new Uint8Array(prefixSize);
  let offset = 0;
  for (const chunk of prefixChunks) {
    prefix.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { size, prefix };
}

/**
 * Bind one existing application-owned directory as a portable Node/Bun file boundary.
 * Concurrent replacement by another filesystem actor is intentionally outside this
 * portable threat model; use OS-specific descriptor-relative isolation for that case.
 */
export async function createManagedFileBoundary(
  config: ManagedFileBoundaryConfig,
): Promise<ManagedFileBoundary> {
  const root = await bindRoot(config);
  const maxReadBytes = positiveLimit(config.maxReadBytes, DEFAULT_MAX_BYTES, 'maxReadBytes');
  const maxWriteBytes = positiveLimit(
    config.maxWriteBytes,
    DEFAULT_MAX_BYTES,
    'maxWriteBytes',
  );
  const inspectionBytes = positiveLimit(
    config.inspectionBytes,
    DEFAULT_INSPECTION_BYTES,
    'inspectionBytes',
  );
  const inspectionTimeoutMs = positiveLimit(
    config.inspectionTimeoutMs,
    DEFAULT_INSPECTION_TIMEOUT_MS,
    'inspectionTimeoutMs',
  );

  const targetFor = (path: string): { path: string; target: string } => {
    const relative = filePath(path);
    const target = resolve(root, ...relative.split('/'));
    if (!isWithinDir(root, target)) {
      throw new ManagedFileError(
        'FILE_OUTSIDE_ROOT',
        'managed-file path escapes its boundary',
      );
    }
    return { path: relative, target };
  };

  return {
    async read(path, options = {}) {
      const resolved = targetFor(path);
      options.signal?.throwIfAborted();
      const realTarget = await realpathOrNull(
        resolved.target,
        'failed to resolve managed file',
      );
      if (realTarget === null) {
        throw new ManagedFileError('FILE_NOT_FOUND', 'managed file not found');
      }
      if (!isWithinDir(root, realTarget)) {
        throw new ManagedFileError(
          'FILE_OUTSIDE_ROOT',
          'managed-file path escapes its boundary',
        );
      }
      const maxBytes = positiveLimit(options.maxBytes, maxReadBytes, 'maxBytes');
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(realTarget, constants.O_RDONLY | NOFOLLOW_FLAG);
        const info = await handle.stat();
        if (!info.isFile()) {
          throw new ManagedFileError('FILE_NOT_REGULAR', 'managed path is not a regular file');
        }
        const bytes = await readHandle(handle, maxBytes, options.signal);
        const inspection = await inspectFile(
          config.inspect,
          {
            prefix: bytes.slice(0, inspectionBytes),
            name: basename(resolved.path),
          },
          inspectionTimeoutMs,
          options.signal,
        );
        return {
          ref: inspectedRef(resolved.path, bytes.byteLength, inspection),
          bytes,
        };
      } catch (error) {
        if (options.signal?.aborted && error === options.signal.reason) throw error;
        if (errorCode(error) === 'ENOENT') {
          throw new ManagedFileError('FILE_NOT_FOUND', 'managed file not found');
        }
        throw ioError('failed to read managed file', error);
      } finally {
        await handle?.close().catch(() => undefined);
      }
    },

    async write(path, source, options = {}) {
      options.signal?.throwIfAborted();
      const resolved = targetFor(path);
      const parent = await existingParent(root, resolved.target);
      const maxBytes = positiveLimit(options.maxBytes, maxWriteBytes, 'maxBytes');
      const temporary = resolve(parent, `.stitchkit-${randomUUID()}.tmp`);
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      let committed = false;
      let size = 0;
      try {
        handle = await open(
          temporary,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW_FLAG,
          0o600,
        );
        const written = await writeSource(
          handle,
          source,
          maxBytes,
          inspectionBytes,
          options.signal,
        );
        size = written.size;
        if (options.durable) await handle.sync();
        await handle.close();
        handle = undefined;

        const inspection = await inspectFile(
          config.inspect,
          {
            prefix: written.prefix,
            ...(options.mediaType ? { declaredMediaType: options.mediaType } : {}),
            name: options.name ?? basename(resolved.path),
          },
          inspectionTimeoutMs,
          options.signal,
        );

        options.signal?.throwIfAborted();

        if (options.replace) {
          await rename(temporary, resolved.target);
          committed = true;
        } else {
          try {
            await link(temporary, resolved.target);
            committed = true;
          } catch (error) {
            if (errorCode(error) === 'EEXIST') {
              throw new ManagedFileError('FILE_EXISTS', 'managed file already exists');
            }
            throw error;
          }
        }

        return inspectedRef(resolved.path, size, inspection, {
          mediaType: options.mediaType,
          name: options.name,
        });
      } catch (error) {
        if (options.signal?.aborted && error === options.signal.reason) throw error;
        throw ioError('failed to write managed file', error);
      } finally {
        await handle?.close().catch(() => undefined);
        if (!options.replace || !committed) {
          await unlink(temporary).catch((error) => {
            if (errorCode(error) !== 'ENOENT') config.onCleanupError?.(error);
          });
        }
      }
    },
  };
}
