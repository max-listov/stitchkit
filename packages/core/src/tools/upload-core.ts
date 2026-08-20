import type { ManagedFileBoundary, ManagedFileSource } from '../files/boundary';

/** Read one bounded managed source and hand its immutable bytes to an uploader. */
export function runUploadOperation<T>(
  files: ManagedFileBoundary,
  path: string,
  upload: (source: ManagedFileSource, signal?: AbortSignal) => T | Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  return files.read(path, { signal }).then((source) => upload(source, signal));
}
