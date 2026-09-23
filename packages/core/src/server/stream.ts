import { normalizeError } from '../contract/normalize';

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
