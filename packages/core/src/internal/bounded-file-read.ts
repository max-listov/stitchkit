import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import {
  type BoundedFileSnapshotHooks,
  type BoundedFileSnapshotSyncHooks,
  bigObservation,
  defaultNamedStat,
  defaultNamedStatSync,
  type FilePathStat,
  isNanosecondStats,
  isPathSwapErrno,
  matchesNamedPath,
  sameBigStat,
  sameReadStat,
  statsViewOf,
  toObservation,
} from './bounded-file-confirm';
import { closeAfter, closeAfterSync } from './close-after';
import { errnoOf } from './errno';
import type {
  FileObservation,
  FileReadDescriptor,
  FileReadStat,
  FileStatsView,
  NanosecondFileStats,
} from './file-observation';

export class BoundedFileReadError extends Error {
  constructor(
    readonly code:
      | 'FILE_UNSUPPORTED'
      | 'FILE_NOT_REGULAR'
      | 'FILE_UNSAFE_LINK'
      | 'FILE_TOO_LARGE'
      | 'FILE_CHANGED',
    message: string,
    readonly observation?: FileObservation,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'BoundedFileReadError';
  }
}

export interface FileOpenOptions {
  /** Refuse a symlink at the leaf: the open itself does not follow it. Without it a symlink is followed. */
  rejectSymlinks?: boolean;
  /** Require descriptor nlink===1; transient publication links are also refused. */
  singleLink?: boolean;
}

export interface BoundedFileReadOptions<S extends FileReadStat = FileReadStat>
  extends FileOpenOptions {
  stable?: boolean;
  signal?: AbortSignal;
  /** Runs on the open descriptor's `stat()` before any byte is read; throwing refuses the file. */
  inspect?: (before: S | FileStatsView) => void;
}

export function isNonRegularOpenErrno(code: string | undefined): boolean {
  return code === 'EISDIR' || code === 'ENXIO' || code === 'EOPNOTSUPP';
}

function openReadFlags(options: FileOpenOptions): number {
  if (options.rejectSymlinks && !constants.O_NOFOLLOW)
    throw new BoundedFileReadError('FILE_UNSUPPORTED', 'strict leaf nofollow is unavailable');
  return (
    constants.O_RDONLY |
    (options.rejectSymlinks ? (constants.O_NOFOLLOW ?? 0) : 0) |
    (constants.O_NONBLOCK ?? 0)
  );
}

/**
 * The one descriptor open: the descriptor, not the path, decides that the file
 * is regular and has the requested link count. The caller closes the handle.
 * Reads never block on a FIFO because the open is non-blocking.
 */
async function openChecked<S extends FileReadStat, D extends FileReadDescriptor<S>>(
  target: string,
  options: FileOpenOptions,
  openDescriptor: (path: string, flags: number) => Promise<D>,
): Promise<{ handle: D; before: S | NanosecondFileStats }> {
  const flags = openReadFlags(options);
  let handle: D;
  try {
    handle = await openDescriptor(target, flags);
  } catch (error) {
    const code = errnoOf(error);
    if (options.rejectSymlinks && code === 'ELOOP')
      throw new BoundedFileReadError(
        'FILE_UNSAFE_LINK',
        'managed file leaf is a symlink',
        undefined,
        { cause: error },
      );
    if (isNonRegularOpenErrno(code))
      throw new BoundedFileReadError(
        'FILE_NOT_REGULAR',
        'managed path is not a regular file',
        undefined,
        { cause: error },
      );
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile())
      throw new BoundedFileReadError('FILE_NOT_REGULAR', 'managed path is not a regular file');
    const nlink = typeof before.nlink === 'bigint' ? Number(before.nlink) : before.nlink;
    if (options.singleLink && nlink !== 1)
      throw new BoundedFileReadError(
        'FILE_UNSAFE_LINK',
        'managed file has multiple links',
        toObservation(before),
      );
    return { handle, before };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Open a regular file by descriptor for a caller that streams it; the caller closes the
 * handle.
 */
export async function openRegularFile(
  target: string,
  options: FileOpenOptions = {},
): Promise<{ handle: FileHandle; before: FileObservation }> {
  const { handle, before } = await openChecked(target, options, open);
  return { handle, before: toObservation(before) };
}

const tooLarge = (maxBytes: number, observation?: FileObservation): BoundedFileReadError =>
  new BoundedFileReadError(
    'FILE_TOO_LARGE',
    `file exceeds the ${maxBytes}-byte cap`,
    observation,
  );

/**
 * The descriptor decides kind/link/stability; bytes are capped before allocation grows.
 */
export function readBoundedFile(
  target: string,
  maxBytes: number,
  options: BoundedFileReadOptions = {},
  openDescriptor: (path: string, flags: number) => Promise<FileReadDescriptor> = open,
): Promise<BoundedFileRead> {
  return readBoundedFileFrom(target, maxBytes, options, openDescriptor);
}

export interface BoundedFileRead {
  bytes: Uint8Array;
  observation: FileObservation;
  mode: number | undefined;
  /** Exact nanosecond post-read stat when the open descriptor supports `{ bigint: true }`. */
  after?: NanosecondFileStats;
}

function confirmNamedPath(
  after: { dev: number | bigint; ino: number | bigint },
  named: FilePathStat,
): void {
  if (!matchesNamedPath(after, named)) {
    throw new BoundedFileReadError('FILE_CHANGED', 'managed file path changed during read');
  }
}

/** {@link readBoundedFile} over a caller's opener, whose stat type `inspect` receives. */
export async function readBoundedFileFrom<S extends FileReadStat>(
  target: string,
  maxBytes: number,
  options: BoundedFileReadOptions<S>,
  openDescriptor: (path: string, flags: number) => Promise<FileReadDescriptor<S>>,
  snapshot: BoundedFileSnapshotHooks = {},
): Promise<BoundedFileRead> {
  options.signal?.throwIfAborted();
  const { handle, before } = await openChecked<S, FileReadDescriptor<S>>(
    target,
    options,
    openDescriptor,
  );
  return closeAfter(handle, async () => {
    try {
      options.signal?.throwIfAborted();
      const beforeSize = typeof before.size === 'bigint' ? before.size : BigInt(before.size);
      if (beforeSize > BigInt(maxBytes)) throw tooLarge(maxBytes);
      options.inspect?.(isNanosecondStats(before) ? statsViewOf(before) : before);
      const bytes = await readHandle(handle, maxBytes, options.signal);
      const after = await handle.stat({ bigint: true });
      if (options.stable && !sameReadStat(before, after, bytes.length))
        throw new BoundedFileReadError('FILE_CHANGED', 'managed file changed during read');
      if (options.stable) {
        options.signal?.throwIfAborted();
        let named: FilePathStat;
        try {
          named = snapshot.namedStat
            ? await snapshot.namedStat(target)
            : await defaultNamedStat(target, options.rejectSymlinks);
        } catch (error) {
          if (isPathSwapErrno(errnoOf(error), options.rejectSymlinks)) {
            throw new BoundedFileReadError(
              'FILE_CHANGED',
              'managed file path changed during read',
              undefined,
              {
                cause: error,
              },
            );
          }
          throw error;
        }
        confirmNamedPath(after, named);
      }
      options.signal?.throwIfAborted();
      return {
        bytes,
        observation: toObservation(after),
        mode: after.mode === undefined ? undefined : Number(after.mode),
        ...(isNanosecondStats(after) && { after }),
      };
    } catch (error) {
      // An oversized file carries the descriptor's observation so a caller can
      // set that exact file aside instead of failing the whole read.
      if (error instanceof BoundedFileReadError && error.code === 'FILE_TOO_LARGE') {
        const current = await handle.stat({ bigint: true }).catch(() => undefined);
        if (current?.isFile()) {
          const curObs = toObservation(current);
          const beforeObs = toObservation(before);
          if (curObs.dev === beforeObs.dev && curObs.ino === beforeObs.ino)
            throw tooLarge(maxBytes, curObs);
        }
      }
      throw error;
    }
  });
}

function readFdSync(fd: number, maxBytes: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let ended = false;
  while (!ended) {
    const capacity = Math.min(64 * 1024, maxBytes + 1 - total);
    if (capacity <= 0) throw tooLarge(maxBytes);
    const chunk = new Uint8Array(capacity);
    let filled = 0;
    while (filled < capacity) {
      const bytesRead = readSync(fd, chunk, filled, capacity - filled, null);
      if (bytesRead === 0) {
        ended = true;
        break;
      }
      filled += bytesRead;
      total += bytesRead;
      if (total > maxBytes) throw tooLarge(maxBytes);
    }
    if (filled > 0) chunks.push(chunk.subarray(0, filled));
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** What the sync reader hands `inspect`: a descriptor `fstat` view derived from `before`. */
export type SyncFileStat = FileStatsView;

export interface BoundedFileReadSyncOptions extends FileOpenOptions {
  stable?: boolean;
  /** Runs on the open descriptor's `fstat` before any byte is read; throwing refuses the file. */
  inspect?: (before: SyncFileStat) => void;
}

/**
 * Synchronous counterpart of {@link readBoundedFile}: opens with `O_RDONLY | O_NONBLOCK`
 * (plus `O_NOFOLLOW` when `rejectSymlinks` is true), validates `fstat` regular file and
 * link/size caps (including `maxBytes === 0`), and returns bytes, observation, mode and
 * the nanosecond `fstat` taken after the read (`after`) for an exact identity.
 */
export function readBoundedFileSync(
  target: string,
  maxBytes: number,
  options: BoundedFileReadSyncOptions = {},
  openFd: (path: string, flags: number) => number = openSync,
  snapshot: BoundedFileSnapshotSyncHooks = {},
): { bytes: Uint8Array; observation: FileObservation; mode: number; after: BigIntStats } {
  const flags = openReadFlags(options);
  let fd: number;
  try {
    fd = openFd(target, flags);
  } catch (error) {
    const code = errnoOf(error);
    if (options.rejectSymlinks && code === 'ELOOP')
      throw new BoundedFileReadError(
        'FILE_UNSAFE_LINK',
        'managed file leaf is a symlink',
        undefined,
        { cause: error },
      );
    if (isNonRegularOpenErrno(code))
      throw new BoundedFileReadError(
        'FILE_NOT_REGULAR',
        'managed path is not a regular file',
        undefined,
        { cause: error },
      );
    throw error;
  }
  return closeAfterSync(
    () => closeSync(fd),
    () => {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile())
        throw new BoundedFileReadError(
          'FILE_NOT_REGULAR',
          'managed path is not a regular file',
        );
      if (options.singleLink && before.nlink !== 1n)
        throw new BoundedFileReadError(
          'FILE_UNSAFE_LINK',
          'managed file has multiple links',
          bigObservation(before),
        );
      try {
        if (before.size > BigInt(maxBytes)) throw tooLarge(maxBytes);
        options.inspect?.(statsViewOf(before));
        const bytes = readFdSync(fd, maxBytes);
        const after = fstatSync(fd, { bigint: true });
        if (options.stable && !sameBigStat(before, after, bytes.length))
          throw new BoundedFileReadError('FILE_CHANGED', 'managed file changed during read');
        if (options.stable) {
          let named: FilePathStat;
          try {
            named = snapshot.namedStatSync
              ? snapshot.namedStatSync(target)
              : defaultNamedStatSync(target, options.rejectSymlinks);
          } catch (error) {
            if (isPathSwapErrno(errnoOf(error), options.rejectSymlinks)) {
              throw new BoundedFileReadError(
                'FILE_CHANGED',
                'managed file path changed during read',
                undefined,
                { cause: error },
              );
            }
            throw error;
          }
          confirmNamedPath(after, named);
        }
        return { bytes, observation: bigObservation(after), mode: Number(after.mode), after };
      } catch (error) {
        if (error instanceof BoundedFileReadError && error.code === 'FILE_TOO_LARGE') {
          let current: BigIntStats | undefined;
          try {
            current = fstatSync(fd, { bigint: true });
          } catch {
            current = undefined;
          }
          if (current?.isFile() && current.dev === before.dev && current.ino === before.ino)
            throw tooLarge(maxBytes, bigObservation(current));
        }
        throw error;
      }
    },
  );
}

export async function readHandle(
  handle: {
    read(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesRead: number }>;
  },
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let ended = false;
  while (!ended) {
    const capacity = Math.min(64 * 1024, maxBytes + 1 - total);
    if (capacity <= 0) throw tooLarge(maxBytes);
    const chunk = new Uint8Array(capacity);
    let filled = 0;
    // A short read reuses the block. Retaining a 64-KiB allocation per single
    // byte read would turn a byte cap into a much larger hidden memory cap.
    while (filled < capacity) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(chunk, filled, capacity - filled);
      if (bytesRead === 0) {
        ended = true;
        break;
      }
      filled += bytesRead;
      total += bytesRead;
      if (total > maxBytes) throw tooLarge(maxBytes);
    }
    if (filled > 0) chunks.push(chunk.subarray(0, filled));
  }
  signal?.throwIfAborted();
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
