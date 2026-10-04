import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export interface FileObservation {
  dev: number;
  ino: number;
  size: number;
  nlink: number;
  mtimeMs: number;
  ctimeMs: number;
}

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
  ) {
    super(message);
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

export interface BoundedFileReadOptions {
  rejectSymlinks?: boolean;
  singleLink?: boolean;
  stable?: boolean;
  signal?: AbortSignal;
}

/** The descriptor decides kind/link/stability; bytes are capped before allocation grows. */
export async function readBoundedFile(
  target: string,
  maxBytes: number,
  options: BoundedFileReadOptions = {},
  openDescriptor: (path: string, flags: number) => Promise<FileReadDescriptor> = open,
): Promise<{ bytes: Uint8Array; observation: FileObservation }> {
  if (options.rejectSymlinks && !constants.O_NOFOLLOW)
    throw new BoundedFileReadError('FILE_UNSUPPORTED', 'strict leaf nofollow is unavailable');
  options.signal?.throwIfAborted();
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const handle = await openDescriptor(target, flags);
  let failed = false;
  let failure: unknown;
  let before: FileReadStat | undefined;
  let source: { bytes: Uint8Array; observation: FileObservation } | undefined;
  try {
    options.signal?.throwIfAborted();
    before = await handle.stat();
    if (!before.isFile())
      throw new BoundedFileReadError('FILE_NOT_REGULAR', 'managed path is not a regular file');
    if (options.singleLink && before.nlink !== 1)
      throw new BoundedFileReadError('FILE_UNSAFE_LINK', 'managed file has multiple links');
    if (before.size > maxBytes)
      throw new BoundedFileReadError(
        'FILE_TOO_LARGE',
        `file exceeds the ${maxBytes}-byte cap`,
      );
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
    source = { bytes, observation: observationOf(after) };
  } catch (error) {
    failed = true;
    failure = error;
    if (error instanceof BoundedFileReadError && error.code === 'FILE_TOO_LARGE' && before) {
      const after = await handle.stat().catch(() => undefined);
      if (
        after?.isFile() &&
        after.dev === before.dev &&
        after.ino === before.ino &&
        after.nlink === 1
      )
        failure = new BoundedFileReadError(error.code, error.message, observationOf(after));
    }
  } finally {
    try {
      await handle.close();
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
  }
  if (failed) throw failure;
  if (source === undefined) throw new Error('Read completed without a result');
  return source;
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
    if (capacity <= 0)
      throw new BoundedFileReadError(
        'FILE_TOO_LARGE',
        `file exceeds the ${maxBytes}-byte cap`,
      );
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
      if (total > maxBytes)
        throw new BoundedFileReadError(
          'FILE_TOO_LARGE',
          `file exceeds the ${maxBytes}-byte cap`,
        );
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
