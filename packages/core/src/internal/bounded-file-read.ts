import { constants } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { closeAfter } from './close-after';
import type { FileObservation } from './file-observation';

interface FileReadStat extends FileObservation {
  isFile(): boolean;
}

interface FileReadDescriptor {
  stat(): Promise<FileReadStat>;
  read(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

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

export interface BoundedFileReadOptions extends FileOpenOptions {
  stable?: boolean;
  signal?: AbortSignal;
}

function missingCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

/**
 * The one descriptor open: the descriptor, not the path, decides that the file
 * is regular and has the requested link count. The caller closes the handle.
 * Reads never block on a FIFO because the open is non-blocking.
 */
async function openChecked<D extends FileReadDescriptor>(
  target: string,
  options: FileOpenOptions,
  openDescriptor: (path: string, flags: number) => Promise<D>,
): Promise<{ handle: D; before: FileReadStat }> {
  if (options.rejectSymlinks && !constants.O_NOFOLLOW)
    throw new BoundedFileReadError('FILE_UNSUPPORTED', 'strict leaf nofollow is unavailable');
  const flags =
    constants.O_RDONLY |
    (options.rejectSymlinks ? (constants.O_NOFOLLOW ?? 0) : 0) |
    (constants.O_NONBLOCK ?? 0);
  let handle: D;
  try {
    handle = await openDescriptor(target, flags);
  } catch (error) {
    if (options.rejectSymlinks && missingCode(error) === 'ELOOP')
      throw new BoundedFileReadError(
        'FILE_UNSAFE_LINK',
        'managed file leaf is a symlink',
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
export async function readBoundedFile(
  target: string,
  maxBytes: number,
  options: BoundedFileReadOptions = {},
  openDescriptor: (path: string, flags: number) => Promise<FileReadDescriptor> = open,
): Promise<{ bytes: Uint8Array; observation: FileObservation }> {
  options.signal?.throwIfAborted();
  const { handle, before } = await openChecked(target, options, openDescriptor);
  return closeAfter(handle, async () => {
    try {
      options.signal?.throwIfAborted();
      if (before.size > maxBytes) throw tooLarge(maxBytes);
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
          bytes.length !== after.size)
      )
        throw new BoundedFileReadError('FILE_CHANGED', 'managed file changed during read');
      options.signal?.throwIfAborted();
      return { bytes, observation: observationOf(after) };
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
