export { type ParseSSEOptions, parseSSE } from '../server/stream';

import { DEFAULT_STREAM_LINE_BYTES, readBoundedUtf8Lines } from '../internal/bounded-lines';

export { DEFAULT_STREAM_LINE_BYTES } from '../internal/bounded-lines';

/** Options for `parseNDJSON`. */
export interface ParseNDJSONOptions {
  /** Maximum bytes retained for one line. Default 1 MiB. */
  maxLineBytes?: number;
  /** Called for invalid UTF-8/JSON; without it parsing fails closed. */
  onParseError?: (raw: string, error: Error) => void;
}

function parseFailure(
  raw: string,
  error: unknown,
  onParseError: ParseNDJSONOptions['onParseError'],
): void {
  const failure = error instanceof Error ? error : new Error(String(error));
  if (!onParseError) throw failure;
  onParseError(raw, failure);
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
  try {
    for await (const rawLine of readBoundedUtf8Lines(
      response,
      options?.maxLineBytes ?? DEFAULT_STREAM_LINE_BYTES,
    )) {
      const line = (rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine).trim();
      if (line === '') continue;
      try {
        yield JSON.parse(line);
      } catch (error) {
        parseFailure(line, error, options?.onParseError);
      }
    }
  } catch (error) {
    parseFailure('', error, options?.onParseError);
  }
}
