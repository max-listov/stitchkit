import { abortReason, raceAbort } from './abort-race';
import { assertPositiveSafeInteger } from './positive-integer';
import { chunksOf, type StreamByteSource } from './stream-chunks';

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
  source: StreamByteSource | null | undefined,
  options: BoundedChunksOptions,
): Promise<BoundedChunksResult> {
  options.signal?.throwIfAborted();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (source === null) return { kind: 'complete', chunks, total };
  if (source === undefined) {
    throw new TypeError(
      'Bounded body source is undefined — this runtime does not expose a readable body stream',
    );
  }
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

/** Exact UTF-8 byte length of a JS string without depending on `TextEncoder`. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
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

/** How a bounded UTF-8 text read of a `Request` or `Response` ended, other than by an abort. */
export type BoundedTextResult =
  | { readonly kind: 'complete'; readonly text: string }
  | { readonly kind: 'over-limit' };

/** A strict read also ends `not-utf8`: the bytes are not UTF-8, or this runtime cannot show they are. */
export type BoundedUtf8Result = BoundedTextResult | { readonly kind: 'not-utf8' };

export interface BoundedTextOptions {
  /** Maximum UTF-8 bytes allowed; a body of exactly `maxBytes` is read, one byte more is not. */
  readonly maxBytes: number;
  /** Stops the read; the source is cancelled and the read rejects with the signal's reason. */
  readonly signal?: AbortSignal;
  /** When true, refuse a declared `content-length` exceeding `maxBytes` before pulling bytes. */
  readonly checkContentLength?: boolean;
}

/** The checks before any byte is pulled: a cancelled read and a declared length over the limit. */
function overDeclaredLimit(source: Request | Response, options: BoundedTextOptions): boolean {
  assertPositiveSafeInteger('maxBytes', options.maxBytes);
  const { maxBytes, signal, checkContentLength } = options;
  if (signal?.aborted) throw abortReason(signal);
  if (!checkContentLength) return false;
  const rawLength = source.headers?.get('content-length')?.trim();
  if (rawLength !== undefined && /^\d+$/.test(rawLength) && Number(rawLength) > maxBytes) {
    void source.body?.cancel?.().catch(() => undefined);
    return true;
  }
  return false;
}

/**
 * Read a `Request` or `Response` body as UTF-8 text without buffering past `maxBytes`.
 *
 * Checks `signal?.aborted` ahead of reading, lazily constructs `TextDecoder` only when decoding
 * non-empty byte chunks, treats `body === null` as empty, and falls back to `source.text()` with
 * `utf8ByteLength` on runtimes without a readable body stream (e.g. `whatwg-fetch` in React Native)
 * or without `TextDecoder`. Bytes that are not UTF-8 decode as U+FFFD.
 */
export async function readBoundedText(
  source: Request | Response,
  options: BoundedTextOptions,
): Promise<BoundedTextResult> {
  if (overDeclaredLimit(source, options)) return { kind: 'over-limit' };
  const { maxBytes, signal } = options;
  const body = source.body;
  if (body === null) return { kind: 'complete', text: '' };
  if (body === undefined || typeof TextDecoder !== 'function') {
    const pending = source.text();
    const text = await (signal ? raceAbort(pending, signal) : pending);
    if (signal?.aborted) throw abortReason(signal);
    if (utf8ByteLength(text) > maxBytes) return { kind: 'over-limit' };
    return { kind: 'complete', text };
  }

  const result = await readBoundedChunks(body, { maxBytes, signal });
  if (result.kind === 'over-limit') return { kind: 'over-limit' };
  const text =
    result.total === 0
      ? ''
      : new TextDecoder().decode(concatChunks(result.chunks, result.total));
  return { kind: 'complete', text };
}

/**
 * UTF-8 text of `bytes`, or `undefined` when they are not UTF-8 or this runtime cannot tell. A
 * byte order mark stays in the text: encoding it again gives back the bytes that were read.
 */
function strictUtf8(bytes: Uint8Array): string | undefined {
  if (typeof TextDecoder === 'function') {
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return undefined;
    }
  }
  // Without a decoder only ASCII is shown to be UTF-8.
  let text = '';
  for (const byte of bytes) {
    if (byte > 0x7f) return undefined;
    text += String.fromCharCode(byte);
  }
  return text;
}

/**
 * {@link readBoundedText} for a body that must be UTF-8 whatever its type says: bytes that are not
 * UTF-8 end `not-utf8` instead of decoding as U+FFFD. Where the body has no stream (`whatwg-fetch`), its
 * bytes come from `arrayBuffer()`, because `text()` there cannot say what the bytes were.
 */
export async function readBoundedUtf8(
  source: Request | Response,
  options: BoundedTextOptions,
): Promise<BoundedUtf8Result> {
  if (overDeclaredLimit(source, options)) return { kind: 'over-limit' };
  const { maxBytes, signal } = options;
  const body = source.body;
  if (body === null) return { kind: 'complete', text: '' };
  let bytes: Uint8Array;
  if (body === undefined) {
    const pending = source.arrayBuffer();
    const buffer = await (signal ? raceAbort(pending, signal) : pending);
    if (signal?.aborted) throw abortReason(signal);
    if (buffer.byteLength > maxBytes) return { kind: 'over-limit' };
    bytes = new Uint8Array(buffer);
  } else {
    const result = await readBoundedChunks(body, { maxBytes, signal });
    if (result.kind === 'over-limit') return { kind: 'over-limit' };
    bytes = concatChunks(result.chunks, result.total);
  }
  const text = strictUtf8(bytes);
  return text === undefined ? { kind: 'not-utf8' } : { kind: 'complete', text };
}
