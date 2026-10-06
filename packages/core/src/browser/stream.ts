import type { StreamFinalLinePolicy } from '../contract/define';
import {
  createBoundedLineDecoder,
  DEFAULT_STREAM_LINE_BYTES,
  readBoundedUtf8Lines,
  type StreamByteSource,
} from '../internal/bounded-lines';

export {
  DEFAULT_STREAM_LINE_BYTES,
  type StreamByteSource,
  StreamLineLimitError,
  StreamTruncatedLineError,
} from '../internal/bounded-lines';

/** Options for `parseNDJSON` and `createNDJSONDecoder`. */
export interface ParseNDJSONOptions {
  /** Maximum bytes retained for one line; past it, `StreamLineLimitError`. Default 1 MiB. */
  maxLineBytes?: number;
  /** Called for invalid UTF-8/JSON; without it parsing fails closed. */
  onParseError?: (raw: string, error: Error) => void;
  /**
   * Default `allow`; use `require-newline` when a missing delimiter means truncation (a socket or
   * a child's stdout that ends mid-line), so the fragment is `StreamTruncatedLineError`, not a value.
   */
  finalLine?: StreamFinalLinePolicy;
  /** Stops reading and cancels the source; the iteration rejects with the signal's reason. */
  signal?: AbortSignal;
}

/** One NDJSON line as a value: blank keep-alives are skipped, a trailing `\r` is dropped. */
function ndjsonLine(rawLine: string): string {
  return (rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine).trim();
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
 * Parse newline-delimited JSON — the client half of `ndjsonRoute`, and the reader for any other
 * byte source: a `Response`, a `ReadableStream<Uint8Array>` (a fetch body, a Bun child's
 * `stdout`) or an `AsyncIterable<Uint8Array>` (a Node child's `stdout`). A source that delivers
 * bytes through a callback, such as a `Bun.listen` socket, uses `createNDJSONDecoder`.
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
  source: StreamByteSource,
  options?: ParseNDJSONOptions,
): AsyncGenerator<T> {
  /** True while `onParseError` runs, so what it throws is not handed back to it as a read error. */
  let reporting = false;
  try {
    for await (const rawLine of readBoundedUtf8Lines(
      source,
      options?.maxLineBytes ?? DEFAULT_STREAM_LINE_BYTES,
      options?.finalLine === 'require-newline',
      options?.signal,
    )) {
      const line = ndjsonLine(rawLine);
      if (line === '') continue;
      let value: T;
      try {
        value = JSON.parse(line);
      } catch (error) {
        reporting = true;
        parseFailure(line, error, options?.onParseError);
        reporting = false;
        continue;
      }
      yield value;
    }
  } catch (error) {
    // An abort is the caller's decision, not malformed input: it never goes to `onParseError`.
    if (reporting || options?.signal?.aborted) throw error;
    parseFailure('', error, options?.onParseError);
  }
}

/**
 * Push-driven NDJSON for a source that hands over bytes through a callback. `push` returns the
 * values its chunk completed; `end` returns the value of an unterminated final line, or throws
 * `StreamTruncatedLineError` under `finalLine: 'require-newline'`.
 */
export interface NDJSONDecoder<T> {
  push(chunk: Uint8Array): T[];
  end(): T[];
}

/**
 * The same bounded, fatal-UTF-8 NDJSON reading as `parseNDJSON`, for a `Bun.listen` /
 * `Bun.connect` socket's `data` handler or any other callback source. A line past
 * `maxLineBytes` throws `StreamLineLimitError` as soon as it crosses the limit; invalid JSON
 * goes to `onParseError` or throws. (`signal` does not apply: the caller owns the source.)
 */
export function createNDJSONDecoder<T>(
  options?: Omit<ParseNDJSONOptions, 'signal'>,
): NDJSONDecoder<T> {
  const lines = createBoundedLineDecoder(
    options?.maxLineBytes ?? DEFAULT_STREAM_LINE_BYTES,
    options?.finalLine === 'require-newline',
  );
  /** Set at the first error: the lines after a failed one are not parsed, so none is skipped silently. */
  let failed = false;
  const values = (rawLines: string[]): T[] => {
    const parsed: T[] = [];
    for (const rawLine of rawLines) {
      const line = ndjsonLine(rawLine);
      if (line === '') continue;
      try {
        parsed.push(JSON.parse(line));
      } catch (error) {
        parseFailure(line, error, options?.onParseError);
      }
    }
    return parsed;
  };
  const guarded = (step: () => string[]): T[] => {
    if (failed)
      throw new Error('NDJSON decoder stopped at an earlier error; read the source again');
    try {
      return values(step());
    } catch (error) {
      failed = true;
      throw error;
    }
  };
  return {
    push: (chunk) => guarded(() => lines.push(chunk)),
    end: () => guarded(() => lines.end()),
  };
}

/** Options for `parseSSE`. */
export interface ParseSSEOptions {
  /** Maximum bytes retained for one SSE line; past it, `StreamLineLimitError`. Default 1 MiB. */
  maxLineBytes?: number;
  /** Called for invalid UTF-8/JSON; without it parsing fails closed. */
  onParseError?: (raw: string, error: Error) => void;
  /** Stops reading and cancels the source; the iteration rejects with the signal's reason. */
  signal?: AbortSignal;
}

/**
 * Parse Server-Sent Events into an async generator of JSON values — the client counterpart of
 * `streamSSE`. Reads the same byte sources as `parseNDJSON`. Stops at the `[DONE]` sentinel;
 * the source is cancelled on every exit path.
 */
export async function* parseSSE<T>(
  source: StreamByteSource,
  options?: ParseSSEOptions,
): AsyncGenerator<T> {
  /** True while `onParseError` runs, so what it throws is not handed back to it as a read error. */
  let reporting = false;
  try {
    for await (const rawLine of readBoundedUtf8Lines(
      source,
      options?.maxLineBytes ?? DEFAULT_STREAM_LINE_BYTES,
      false,
      options?.signal,
    )) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).replace(/^ /, '');
      if (data === '[DONE]') return;
      let value: T;
      try {
        value = JSON.parse(data);
      } catch (error) {
        reporting = true;
        parseFailure(data, error, options?.onParseError);
        reporting = false;
        continue;
      }
      yield value;
    }
  } catch (error) {
    if (reporting || options?.signal?.aborted) throw error;
    parseFailure('', error, options?.onParseError);
  }
}
