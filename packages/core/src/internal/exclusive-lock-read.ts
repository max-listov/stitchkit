import { BoundedFileReadError, readBoundedFile } from './bounded-file-read';
import type { FileObservation } from './file-observation';

/** Owner records are small JSON objects; one byte past the cap would already be refused. */
const OWNER_RECORD_BYTES = 16 * 1024;

export class LockRecordError extends Error {
  override name = 'LockRecordError';
  constructor(
    readonly code: 'LOCK_UNSAFE_RECORD' | 'LOCK_RECORD_CHANGED' | 'LOCK_RECORD_TOO_LARGE',
    message: string,
  ) {
    super(message);
  }
}

const LOCK_CODE = {
  FILE_UNSUPPORTED: 'LOCK_UNSAFE_RECORD',
  FILE_NOT_REGULAR: 'LOCK_UNSAFE_RECORD',
  FILE_UNSAFE_LINK: 'LOCK_UNSAFE_RECORD',
  FILE_TOO_LARGE: 'LOCK_RECORD_TOO_LARGE',
  FILE_CHANGED: 'LOCK_RECORD_CHANGED',
} satisfies Record<BoundedFileReadError['code'], LockRecordError['code']>;

/** A descriptor-bound observation of a lock file: a regular, single-link, stable, capped read. */
export async function readLockRecord(
  path: string,
  {
    openDescriptor,
    signal,
    singleLink = true,
  }: {
    openDescriptor?: Parameters<typeof readBoundedFile>[3];
    signal?: AbortSignal;
    /** `false` only for a lock whose second name was proven to be its own staging file. */
    singleLink?: boolean;
  } = {},
): Promise<{ text: string; info: FileObservation }> {
  try {
    const { bytes, observation } = await readBoundedFile(
      path,
      OWNER_RECORD_BYTES,
      { rejectSymlinks: true, singleLink, stable: true, ...(signal && { signal }) },
      openDescriptor,
    );
    return {
      text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes),
      info: observation,
    };
  } catch (error) {
    if (error instanceof BoundedFileReadError)
      throw new LockRecordError(LOCK_CODE[error.code], error.message);
    throw error;
  }
}
