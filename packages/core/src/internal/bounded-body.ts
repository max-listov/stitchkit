import { assertPositiveSafeInteger } from './positive-integer';
import { chunksOf, type StreamByteSource } from './stream-chunks';
import { abortReason } from './until-aborted';

/** How a bounded read of a byte source ended, other than by an abort. */
export type BoundedChunksResult =
  | { readonly kind: 'complete'; readonly chunks: Uint8Array[]; readonly total: number }
  /** The source crossed `maxBytes`; `total` counts the chunk that crossed it. */
  | { readonly kind: 'over-limit'; readonly total: number };

export interface BoundedChunksOptions {
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
  /** Called with every chunk read, including the one that crosses the limit. */
  readonly onChunk?: (chunk: Uint8Array) => void;
}

/**
 * Read a source up to `maxBytes`. The read stops at the first chunk that crosses the limit, so
 * memory stays bounded by the limit plus one chunk, and the source is cancelled. A `null` source
 * is empty. An abort rejects with the signal's reason, before the first read as well as during
 * one; it is checked ahead of the empty-source answer.
 */
export async function readBoundedChunks(
  source: StreamByteSource | null,
  options: BoundedChunksOptions,
): Promise<BoundedChunksResult> {
  options.signal?.throwIfAborted();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (source === null) return { kind: 'complete', chunks, total };
  for await (const chunk of chunksOf(source, options.signal)) {
    // A stream with an encoding set yields strings, which have no `byteLength`: counting them as
    // `NaN` would read the whole source past any limit.
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError('A bounded body source must yield bytes (Uint8Array chunks)');
    }
    total += chunk.byteLength;
    options.onChunk?.(chunk);
    if (total > options.maxBytes) return { kind: 'over-limit', total };
    chunks.push(chunk);
  }
  return { kind: 'complete', chunks, total };
}

/** One byte array from the chunks of a finished read. */
export function concatChunks(
  chunks: readonly Uint8Array[],
  total: number,
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export interface BoundedBodyOptions {
  /** The most bytes the body may hold; a body of exactly `maxBytes` is read, one byte more is not. */
  maxBytes: number;
  /** Stops the read; the source is cancelled and the read rejects with `abortError` or the signal's reason. */
  signal?: AbortSignal;
  /** The error to throw when the body crosses `maxBytes`; `observedBytes` counts the chunk that crossed it. */
  limitError: (observedBytes: number) => unknown;
  /** The error to throw when `signal` aborts; the signal's reason when omitted. */
  abortError?: (reason: unknown) => unknown;
}

/**
 * The whole body as bytes, never reading past `maxBytes` plus one chunk. A `null` body is an empty
 * result. The source is cancelled when the limit is crossed and when the signal aborts, and the
 * caller picks both errors, so a limit and a cancellation stay different outcomes.
 */
export async function readBoundedBody(
  source: StreamByteSource | null,
  options: BoundedBodyOptions,
): Promise<Uint8Array<ArrayBuffer>> {
  assertPositiveSafeInteger('maxBytes', options.maxBytes);
  let result: BoundedChunksResult;
  try {
    result = await readBoundedChunks(source, options);
  } catch (error) {
    const { signal, abortError } = options;
    if (signal?.aborted && abortError) throw abortError(abortReason(signal));
    throw error;
  }
  if (result.kind === 'over-limit') throw options.limitError(result.total);
  return concatChunks(result.chunks, result.total);
}
