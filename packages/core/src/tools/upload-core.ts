/** Run one upload without owning schemas, registration or presentation. */
export function runUploadOperation<T>(
  path: string,
  upload: (path: string, signal?: AbortSignal) => T | Promise<T>,
  signal?: AbortSignal,
): T | Promise<T> {
  signal?.throwIfAborted();
  return upload(path, signal);
}
