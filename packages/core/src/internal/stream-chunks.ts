import { abortReason, raceAbort } from './abort-race';
import { isRecord } from './typed';

/** Bytes a stream reader accepts: a `Response` body, a web stream, or any async byte iterable. */
export type StreamByteSource =
  | Response
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>;

/** A response of any fetch runtime whose body can be read as a web stream. */
export type StreamResponse = { readonly body: ReadableStream<Uint8Array> };

/** Whether a value is a web byte stream, by its reader rather than by the global class. */
function isReadableByteStream(value: unknown): value is ReadableStream<Uint8Array> {
  return isRecord(value) && typeof value.getReader === 'function';
}

/**
 * Whether a value is a response with a readable body — the global `Response` or another runtime's,
 * such as the `FetchResponse` of `expo/fetch`, which is its own class. A response without a body is
 * not one.
 */
export function isStreamResponse(value: unknown): value is StreamResponse {
  return isRecord(value) && isReadableByteStream(value.body);
}

/**
 * The bytes of a source, recognised by shape rather than by class: a web stream by its reader, an
 * async iterable by `Symbol.asyncIterator` — a Node request is one even when a body parser set
 * `req.body` on it — and anything else is a response read through its `body`, whichever runtime's
 * fetch produced it.
 */
function bytesOf(
  source: StreamByteSource,
): ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | null {
  if (isReadableByteStream(source)) return source;
  if (Symbol.asyncIterator in source) return source;
  // A fetch that buffers the whole body (React Native's default) answers without a stream.
  if (source.body === undefined)
    throw new TypeError('The response has no body stream to read');
  return source.body;
}

/**
 * Every chunk of a byte source: the chunk loop the line readers and the bounded body readers
 * share. The source is cancelled or returned on every exit path.
 *
 * An abort ends the loop with the signal's reason even while a read is pending: the pending read
 * is cancelled but not waited for, because a transport stream may leave it pending for good. For
 * the same reason a lock is not released after an abort — releasing it under a pending read throws
 * on some runtimes — and the cancellation is not awaited.
 */
export async function* chunksOf(
  source: StreamByteSource,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  signal?.throwIfAborted();
  const stream = bytesOf(source);
  if (stream === null) return;
  if (isReadableByteStream(stream)) {
    // A reader, not async iteration: some browsers ship web streams without `Symbol.asyncIterator`.
    const reader = stream.getReader();
    const abort = () => {
      if (signal) void reader.cancel(abortReason(signal)).catch(() => undefined);
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      for (;;) {
        const pending = reader.read();
        const chunk = await (signal ? raceAbort(pending, signal) : pending);
        signal?.throwIfAborted();
        if (chunk.done) return;
        yield chunk.value;
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) {
        void reader.cancel(abortReason(signal)).catch(() => undefined);
      } else {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
  }
  const iterator = stream[Symbol.asyncIterator]();
  let finished = false;
  try {
    for (;;) {
      const pending = iterator.next();
      const next = await (signal ? raceAbort(pending, signal) : pending);
      if (next.done) {
        finished = true;
        return;
      }
      yield next.value;
    }
  } finally {
    // After an abort the source's `next()` may still be pending, and an async generator queues
    // `return()` behind it: awaiting it would hang. The return is requested, not awaited.
    if (!finished && signal?.aborted) void iterator.return?.().catch(() => undefined);
    else if (!finished) await iterator.return?.().catch(() => undefined);
  }
}
