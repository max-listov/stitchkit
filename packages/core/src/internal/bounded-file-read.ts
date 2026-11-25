import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  type Stats,
} from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { closeAfter, closeAfterSync } from './close-after';
import { errnoOf } from './errno';
import type { FileObservation, FileReadDescriptor, FileReadStat } from './file-observation';

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

const observationOf = (info: FileObservation): FileObservation => ({
  dev: info.dev,
  ino: info.ino,
  size: info.size,
  nlink: info.nlink,
  mtimeMs: info.mtimeMs,
  ctimeMs: info.ctimeMs,
});

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
  inspect?: (before: S) => void;
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
): Promise<{ handle: D; before: S }> {
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
    const before = await handle.stat();
    if (!before.isFile())
      throw new BoundedFileReadError('FILE_NOT_REGULAR', 'managed path is not a regular file');
    if (options.singleLink && before.nlink !== 1)
      throw new BoundedFileReadError(
        'FILE_UNSAFE_LINK',
        'managed file has multiple links',
        observationOf(before),
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
export function openRegularFile(
  target: string,
  options: FileOpenOptions = {},
): Promise<{ handle: FileHandle; before: FileObservation }> {
  return openChecked(target, options, open);
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
}

/** {@link readBoundedFile} over a caller's opener, whose stat type `inspect` receives. */
export async function readBoundedFileFrom<S extends FileReadStat>(
  target: string,
  maxBytes: number,
  options: BoundedFileReadOptions<S>,
  openDescriptor: (path: string, flags: number) => Promise<FileReadDescriptor<S>>,
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
      if (before.size > maxBytes) throw tooLarge(maxBytes);
      options.inspect?.(before);
      const bytes = await readHandle(handle, maxBytes, options.signal);
      const after = await handle.stat();
      if (
        options.stable &&
        (before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs ||
          before.nlink !== after.nlink ||
          before.mode !== after.mode ||
          before.uid !== after.uid ||
          before.gid !== after.gid ||
          bytes.length !== after.size)
      )
        throw new BoundedFileReadError('FILE_CHANGED', 'managed file changed during read');
      options.signal?.throwIfAborted();
      return { bytes, observation: observationOf(after), mode: after.mode };
    } catch (error) {
      // An oversized file carries the descriptor's observation so a caller can
      // set that exact file aside instead of failing the whole read.
      if (error instanceof BoundedFileReadError && error.code === 'FILE_TOO_LARGE') {
        const current = await handle.stat().catch(() => undefined);
        if (current?.isFile() && current.dev === before.dev && current.ino === before.ino)
          throw tooLarge(maxBytes, observationOf(current));
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

/** What the sync reader hands `inspect`: the descriptor's `fstat`, `fs.Stats` in practice. */
export type SyncFileStat = Stats;

export interface BoundedFileReadSyncOptions extends FileOpenOptions {
  stable?: boolean;
  /** Runs on the open descriptor's `fstat` before any byte is read; throwing refuses the file. */
  inspect?: (before: SyncFileStat) => void;
}

const bigObservation = (info: BigIntStats): FileObservation => ({
  dev: Number(info.dev),
  ino: Number(info.ino),
  size: Number(info.size),
  nlink: Number(info.nlink),
  mtimeMs: Number(info.mtimeMs),
  ctimeMs: Number(info.ctimeMs),
});

function sameBigStat(before: BigIntStats, after: BigIntStats, length: number): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs &&
    before.nlink === after.nlink &&
    before.mode === after.mode &&
    before.uid === after.uid &&
    before.gid === after.gid &&
    BigInt(length) === after.size
  );
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
        options.inspect?.(fstatSync(fd));
        const bytes = readFdSync(fd, maxBytes);
        const after = fstatSync(fd, { bigint: true });
        if (options.stable && !sameBigStat(before, after, bytes.length))
          throw new BoundedFileReadError('FILE_CHANGED', 'managed file changed during read');
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
