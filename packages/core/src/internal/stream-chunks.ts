import { abortReason, untilAborted } from './until-aborted';

/** Bytes a stream reader accepts: a `Response` body, a web stream, or any async byte iterable. */
export type StreamByteSource =
  | Response
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>;

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
  const stream = source instanceof Response ? source.body : source;
  if (stream === null) return;
  if (stream instanceof ReadableStream) {
    // A reader, not async iteration: some browsers ship web streams without `Symbol.asyncIterator`.
    const reader = stream.getReader();
    const abort = () => {
      if (signal) void reader.cancel(abortReason(signal)).catch(() => undefined);
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      for (;;) {
        const pending = reader.read();
        const chunk = await (signal ? untilAborted(pending, signal) : pending);
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
      const next = await (signal ? untilAborted(pending, signal) : pending);
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
