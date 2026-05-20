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

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of generator) {
          const data = JSON.stringify(chunk);
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (err) {
        const envelope = normalizeError(err).toJSON();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(envelope)}\n\n`));
        controller.close();
      }
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
  /** Called for a `data:` line that is not valid JSON — the alternative to throwing. */
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
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        // Tolerate CRLF — the SSE spec uses `\r\n`, not just `\n`.
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (!line.startsWith('data:')) continue;
        // The spec allows `data:value` and `data: value` — one optional space.
        const data = line.slice(5).replace(/^ /, '');
        if (data === '[DONE]') return;
        try {
          yield JSON.parse(data);
        } catch (err) {
          options?.onParseError?.(data, err instanceof Error ? err : new Error(String(err)));
        }
      }
    }
  } finally {
    // Release the stream lock on every exit path — including an early
    // `return` on `[DONE]` or a consumer breaking the loop.
    reader.releaseLock();
  }
}
