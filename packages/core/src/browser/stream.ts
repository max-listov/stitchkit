export { type ParseSSEOptions, parseSSE } from '../server/stream';

/** Options for `parseNDJSON`. */
export interface ParseNDJSONOptions {
  /** Called for a line that is not valid JSON — the alternative to throwing. */
  onParseError?: (raw: string, error: Error) => void;
}

/**
 * Parse a newline-delimited JSON response body — the client half of
 * `ndjsonRoute`.
 *
 * **Blank lines are skipped**, and that is the contract rather than a
 * convenience. A long-lived NDJSON stream has to send something while it is
 * idle or intermediaries drop it, and the natural pulse for this framing is an
 * empty line. Writing the skip down here is what stops it being a verbal
 * agreement between the two halves of one project: the server's keep-alive and
 * the reader's rule are one decision with two implementations.
 *
 * **To end a subscription, abort the request.** Leaving the loop cancels the
 * body — which is right, and this does it — but a client-side cancel is not a
 * reliable way to reach the server: measured against Bun today, the source on
 * the other end stayed alive for seconds afterwards. An aborted request reaches
 * the route's `context.signal` at once.
 */
export async function* parseNDJSON<T>(
  response: Response,
  options?: ParseNDJSONOptions,
): AsyncGenerator<T> {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        // Tolerate CRLF: the frames are produced with `\n`, but a proxy or an
        // intermediary rewriting line endings must not corrupt every frame.
        const line = (rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine).trim();
        if (line === '') continue;
        try {
          yield JSON.parse(line);
        } catch (err) {
          options?.onParseError?.(line, err instanceof Error ? err : new Error(String(err)));
        }
      }
    }
    // A producer that ends without a trailing newline still sent a frame, and
    // NDJSON does not require the last line to be terminated. (A stream cut
    // mid-write leaves a TRUNCATED line instead, which is not valid JSON and
    // goes to `onParseError` — this branch is for well-formed producers, not
    // for recovering torn data.)
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail !== '') {
      try {
        yield JSON.parse(tail);
      } catch (err) {
        options?.onParseError?.(tail, err instanceof Error ? err : new Error(String(err)));
      }
    }
  } finally {
    // CANCEL, not merely release. Releasing the lock leaves the body open, and
    // an open body means the server never learns the consumer left: for a
    // subscription that is a live iterator on the other end with nobody
    // listening. A consumer who `break`s out of this loop — the shape the guide
    // shows — must be able to unsubscribe by doing exactly that.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
