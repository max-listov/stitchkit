/**
 * A file larger than one request, sent as `init` → `chunk` × N → `finalize`
 * through three calls the application already owns — usually three endpoints
 * of its contract. The driver owns only the protocol's rules:
 *
 * - the client mints the upload id, so a repeated `init` is the same upload;
 * - parts go in order, each repeated on a failure that may pass (the network,
 *   a timeout, `429`, `5xx`) with a doubling pause — a part is idempotent,
 *   its server keeps a receipt per index;
 * - `finalize` is never repeated: after it the server owns the file, and a
 *   second call would meet an upload that no longer exists;
 * - cancellation is checked between parts, so a cancelled upload never
 *   reaches `finalize`;
 * - progress counts file bytes, inside a part too, through the part call's
 *   `onUploadProgress`.
 *
 * The server half is `createChunkSpool` in `stitchkit/files`.
 */

import type { ClientRequestOptions, UploadProgress } from '../contract/client-types';
import { sleep } from '../internal/timers';
import { ApiError } from './api-error';

/** How far a chunked upload is, in bytes of the file. */
export interface ChunkedUploadProgress {
  /** File bytes out so far; a repeated part counts again from its start. */
  readonly sentBytes: number;
  readonly totalBytes: number;
  /** The part in flight, from `0`; `chunkCount` once every part is in. */
  readonly index: number;
  readonly chunkCount: number;
  /** Attempt of the part in flight, from `1`. */
  readonly attempt: number;
}

/** What `init` declares; the server checks every part against it. */
export interface ChunkedUploadStart {
  readonly uploadId: string;
  readonly totalBytes: number;
  readonly chunkBytes: number;
  readonly chunkCount: number;
}

/**
 * What the driver reads a file through: its size and a slice per part. A `Blob`
 * is one; so is a platform file that is not a DOM `Blob` — an Expo `File`, a
 * handle over a file on disk — and the part is whatever its `slice` returns.
 */
export interface ChunkSource<TPart = Blob> {
  readonly size: number;
  slice(start: number, end: number): TPart;
}

export interface ChunkedUploadPart<TPart = Blob> {
  readonly uploadId: string;
  readonly index: number;
  /** The file's `slice(start, end)` for this part. */
  readonly bytes: TPart;
}

export interface ChunkedUploadConfig<TResult, TPart = Blob> {
  readonly file: ChunkSource<TPart>;
  /** Bytes per part; every part but the last is exactly this long. */
  readonly chunkBytes: number;
  /**
   * Default `crypto.randomUUID()`, fresh per call. Pass a stable one — the id
   * of the app's own job — to resume after a restart instead of sending again.
   */
  readonly uploadId?: string;
  readonly signal?: AbortSignal;
  /** Repeats of one part (and of `init`) on a failure that may pass. Default 3. */
  readonly retries?: number;
  /** Pause before the first repeat, doubled after each. Default 1000. */
  readonly retryDelayMs?: number;
  readonly onProgress?: (progress: ChunkedUploadProgress) => void;
  /**
   * Open the upload. Resolve with `{ finished }` when the server already holds
   * this upload's result — a repeat after a lost `finalize` answer — and the
   * driver returns it without sending a byte.
   */
  readonly init: (
    start: ChunkedUploadStart,
    options: { signal?: AbortSignal },
  ) => Promise<undefined | { readonly finished: TResult }>;
  /** Send one part; pass `options` on to the client call as they are. */
  readonly chunk: (
    part: ChunkedUploadPart<TPart>,
    options: ClientRequestOptions,
  ) => Promise<unknown>;
  readonly finalize: (
    upload: { readonly uploadId: string },
    options: { signal?: AbortSignal },
  ) => Promise<TResult>;
}

/**
 * Whether repeating the same idempotent call may succeed: no answer reached
 * the client (network, timeout), or the server said "later" (`429`, `5xx`).
 * A caller's abort, a refusal and a conflict are final.
 */
export function isRetryableUploadFailure(error: unknown): boolean {
  if (ApiError.is(error)) {
    if (error.status === 0)
      return error.code === 'UNKNOWN_ERROR' || error.code === 'REQUEST_TIMEOUT';
    return error.status === 429 || error.status >= 500;
  }
  // A plain fetch rejects a network failure with a TypeError.
  return error instanceof TypeError;
}

export async function uploadInChunks<TResult, TPart = Blob>(
  config: ChunkedUploadConfig<TResult, TPart>,
): Promise<TResult> {
  const { file, chunkBytes, signal } = config;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
    throw new TypeError('uploadInChunks: chunkBytes must be a positive integer');
  }
  if (!Number.isSafeInteger(file.size) || file.size < 0) {
    throw new TypeError('uploadInChunks: the file size must be a whole number of bytes');
  }
  if (file.size === 0) throw new TypeError('uploadInChunks: the file is empty');
  const totalBytes = file.size;
  const chunkCount = Math.ceil(totalBytes / chunkBytes);
  const uploadId = config.uploadId ?? crypto.randomUUID();
  const retries = config.retries ?? 3;
  const retryDelayMs = config.retryDelayMs ?? 1_000;
  const report = (sentBytes: number, index: number, attempt: number): void => {
    if (!config.onProgress) return;
    try {
      config.onProgress({ sentBytes, totalBytes, index, chunkCount, attempt });
    } catch {
      // A progress view that throws must not fail the upload it is drawing.
    }
  };

  throwIfAborted(signal);
  const opened = await repeating(
    () => config.init({ uploadId, totalBytes, chunkBytes, chunkCount }, { signal }),
    { retries, retryDelayMs, signal },
  );
  if (opened) {
    report(totalBytes, chunkCount, 1);
    return opened.finished;
  }

  report(0, 0, 1);
  for (let index = 0; index < chunkCount; index += 1) {
    throwIfAborted(signal);
    const start = index * chunkBytes;
    const end = Math.min(totalBytes, start + chunkBytes);
    const partBytes = end - start;
    const bytes = file.slice(start, end);
    await repeating(
      (attempt) =>
        config.chunk(
          { uploadId, index, bytes },
          {
            ...(signal && { signal }),
            onUploadProgress: (progress: UploadProgress) =>
              report(start + fileShare(progress, partBytes), index, attempt),
          },
        ),
      { retries, retryDelayMs, signal },
    );
    report(end, index + 1, 1);
  }

  throwIfAborted(signal);
  return config.finalize({ uploadId }, { signal });
}

/** The file bytes a part's body progress stands for; the body carries framing too. */
function fileShare(progress: UploadProgress, partBytes: number): number {
  if (progress.totalBytes === 0) return 0;
  return Math.floor((partBytes * progress.sentBytes) / progress.totalBytes);
}

async function repeating<T>(
  call: (attempt: number) => Promise<T>,
  {
    retries,
    retryDelayMs,
    signal,
  }: { retries: number; retryDelayMs: number; signal?: AbortSignal },
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call(attempt);
    } catch (error) {
      if (signal?.aborted || attempt > retries || !isRetryableUploadFailure(error))
        throw error;
      try {
        await sleep(retryDelayMs * 2 ** (attempt - 1), signal);
      } catch (aborted) {
        throwIfAborted(signal);
        throw aborted;
      }
    }
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ApiError('REQUEST_ABORTED', { status: 0, message: 'Request was aborted' });
  }
}
