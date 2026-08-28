import { DEFAULT_STREAM_LINE_BYTES, readBoundedUtf8Lines } from '../internal/bounded-lines';
import { normalizeError } from '../internal/errors';

/**
 * Turn an async generator into a Server-Sent Events `Response` — each yielded
 * value is one JSON `data:` event, the stream ends with a `[DONE]` sentinel,
 * and a thrown error is emitted as a final error event. The error is
 * normalised (`normalizeError`) so an internal failure never leaks its raw
 * message into the stream.
 */
export function streamSSE(generator: AsyncGenerator<unknown>): Response {
  const encoder = new TextEncoder();
  let cancelled = false;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of generator) {
          if (cancelled) return;
          const data = JSON.stringify(chunk);
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        }
        if (cancelled) return;
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (err) {
        if (cancelled) return;
        const envelope = normalizeError(err).toJSON();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(envelope)}\n\n`));
        controller.close();
      }
    },
    cancel() {
      cancelled = true;
      // Not awaited, and that is the point. An async generator serialises its
      // requests: a `return()` issued while a `next()` is in flight is queued
      // behind it, so awaiting here makes cancellation wait on the very value
      // the departed consumer was waiting for. The generator is still asked to
      // finish; the cancel simply no longer hangs on the answer.
      //
      // For a source that may WAIT rather than produce — a subscription — use
      // `streamingRoute`, which gives it an abort signal it can honour.
      void generator.return(undefined).catch(() => undefined);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

/** Options for `parseSSE`. */
export interface ParseSSEOptions {
  /** Maximum bytes retained for one SSE line. Default 1 MiB. */
  maxLineBytes?: number;
  /** Called for invalid UTF-8/JSON; without it parsing fails closed. */
  onParseError?: (raw: string, error: Error) => void;
}

/**
 * Parse a Server-Sent Events `Response` body into an async generator of JSON
 * values — the client counterpart of `streamSSE`. Stops at the `[DONE]`
 * sentinel; the stream lock is released on every exit path.
 */
export async function* parseSSE<T>(
  response: Response,
  options?: ParseSSEOptions,
): AsyncGenerator<T> {
  try {
    for await (const rawLine of readBoundedUtf8Lines(
      response,
      options?.maxLineBytes ?? DEFAULT_STREAM_LINE_BYTES,
    )) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).replace(/^ /, '');
      if (data === '[DONE]') return;
      try {
        yield JSON.parse(data);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (!options?.onParseError) throw failure;
        options.onParseError(data, failure);
      }
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (!options?.onParseError) throw failure;
    options.onParseError('', failure);
  }
}
