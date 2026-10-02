import { constants, type Stats } from 'node:fs';
import { open } from 'node:fs/promises';

/** Owner records are small JSON objects; the extra byte detects growth beyond the cap. */
const OWNER_RECORD_BYTES = 16 * 1024;

interface LockRecordDescriptor {
  stat(): Promise<Stats>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export class LockRecordError extends Error {
  override name = 'LockRecordError';
  constructor(
    readonly code: 'LOCK_UNSAFE_RECORD' | 'LOCK_RECORD_CHANGED' | 'LOCK_RECORD_TOO_LARGE',
    message: string,
  ) {
    super(message);
  }
}

/** A descriptor-bound observation, never a pathname stat followed by an unbounded read. */
export async function readLockRecord(
  path: string,
  openDescriptor: (path: string, flags: number) => Promise<LockRecordDescriptor> = open,
  signal?: AbortSignal,
): Promise<{ text: string; info: Stats }> {
  signal?.throwIfAborted();
  if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK) {
    throw new LockRecordError(
      'LOCK_UNSAFE_RECORD',
      'Safe lock descriptor flags are unavailable',
    );
  }
  const handle = await openDescriptor(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    signal?.throwIfAborted();
    const before = await handle.stat();
    signal?.throwIfAborted();
    if (!before.isFile() || before.nlink !== 1) {
      throw new LockRecordError(
        'LOCK_UNSAFE_RECORD',
        'Lock record must be a regular file with one link',
      );
    }
    if (before.size > OWNER_RECORD_BYTES) {
      throw new LockRecordError(
        'LOCK_RECORD_TOO_LARGE',
        'Lock owner record exceeds its byte cap',
      );
    }
    const bytes = Buffer.alloc(OWNER_RECORD_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      signal?.throwIfAborted();
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > OWNER_RECORD_BYTES) {
      throw new LockRecordError(
        'LOCK_RECORD_TOO_LARGE',
        'Lock owner record grew beyond its byte cap',
      );
    }
    const after = await handle.stat();
    signal?.throwIfAborted();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.nlink !== after.nlink ||
      length !== after.size
    ) {
      throw new LockRecordError(
        'LOCK_RECORD_CHANGED',
        'Lock owner record changed during its read',
      );
    }
    return { text: bytes.subarray(0, length).toString('utf8'), info: after };
  } finally {
    await handle.close();
  }
}
