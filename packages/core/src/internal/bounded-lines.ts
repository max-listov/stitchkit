import { assertPositiveSafeInteger } from './positive-integer';
import { abortReason, untilAborted } from './until-aborted';

export const DEFAULT_STREAM_LINE_BYTES = 1024 * 1024;

/**
 * A line grew past its byte limit. The reader throws as soon as the retained bytes cross the
 * limit, so memory stays bounded by the limit plus the chunk being read.
 */
export class StreamLineLimitError extends RangeError {
  override readonly name = 'StreamLineLimitError';
  constructor(
    /** The configured `maxLineBytes`. */
    readonly limitBytes: number,
    /** Bytes of the line seen when it crossed the limit; the line itself is longer still. */
    readonly lineBytes: number,
  ) {
    super(`Stream line exceeds the ${limitBytes} byte limit (${lineBytes} bytes so far)`);
  }
}

/** The source ended inside a line while `finalLine: 'require-newline'` asked for a delimiter. */
export class StreamTruncatedLineError extends SyntaxError {
  override readonly name = 'StreamTruncatedLineError';
  constructor(
    /** Bytes of the unterminated final line. */
    readonly lineBytes: number,
  ) {
    super(`Stream ended with an unterminated final line (${lineBytes} bytes)`);
  }
}

/** Bytes a line reader accepts: a `Response` body, a web stream, or any async byte iterable. */
export type StreamByteSource =
  | Response
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>;

/**
 * Push-driven bounded line splitter for sources that deliver bytes through a callback, such as
 * a `Bun.listen`/`Bun.connect` socket's `data` handler. Lines are split on `\n` in bytes and
 * decoded as fatal UTF-8 only once complete, so a character split across chunks is never torn.
 * An error (a line past the limit, invalid UTF-8) fails the whole `push` and stops the decoder:
 * the bytes after it belong to the failed line, so every later `push` throws.
 */
export interface BoundedLineDecoder {
  /** Feed one chunk; returns the lines it completed, without their `\n`. */
  push(chunk: Uint8Array): string[];
  /**
   * The source ended. Returns the unterminated final line, if any, as one more line, or throws
   * `StreamTruncatedLineError` when a final newline is required.
   */
  end(): string[];
}

function lineLimit(value: number | undefined): number {
  const resolved = value ?? DEFAULT_STREAM_LINE_BYTES;
  assertPositiveSafeInteger('maxLineBytes', resolved);
  return resolved;
}

interface LineSplitter extends BoundedLineDecoder {
  /** The lines of one chunk, yielded one at a time so a later overflow keeps the earlier lines. */
  lines(chunk: Uint8Array): Generator<string>;
}

function createLineSplitter(maxLineBytes?: number, requireFinalNewline = false): LineSplitter {
  const limit = lineLimit(maxLineBytes);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let parts: Uint8Array[] = [];
  let pendingBytes = 0;
  let ended = false;
  /** Set once a line fails: what follows in the source is the rest of that line, not a new one. */
  let failed = false;

  const drop = () => {
    parts = [];
    pendingBytes = 0;
  };
  const retain = (bytes: Uint8Array) => {
    if (bytes.byteLength === 0) return;
    pendingBytes += bytes.byteLength;
    if (pendingBytes > limit) {
      const seen = pendingBytes;
      drop();
      throw new StreamLineLimitError(limit, seen);
    }
    // Copied — a socket may reuse the chunk's buffer for its next read, and `Buffer#slice` is a
    // view, not a copy, so the copy is made through the Uint8Array constructor.
    parts.push(new Uint8Array(bytes));
  };
  const take = (): string => {
    const line = new Uint8Array(pendingBytes);
    let at = 0;
    for (const part of parts) {
      line.set(part, at);
      at += part.byteLength;
    }
    drop();
    return decoder.decode(line);
  };
  function* lines(chunk: Uint8Array): Generator<string> {
    if (ended) throw new Error('Line decoder received bytes after end()');
    if (failed)
      throw new Error('Line decoder stopped at an earlier error; read the source again');
    try {
      let start = 0;
      for (let index = chunk.indexOf(0x0a); index !== -1; index = chunk.indexOf(0x0a, start)) {
        retain(chunk.subarray(start, index));
        yield take();
        start = index + 1;
      }
      retain(chunk.subarray(start));
    } catch (error) {
      failed = true;
      throw error;
    }
  }
  return {
    lines,
    push: (chunk) => [...lines(chunk)],
    end() {
      ended = true;
      if (pendingBytes === 0) return [];
      if (requireFinalNewline) {
        const seen = pendingBytes;
        drop();
        throw new StreamTruncatedLineError(seen);
      }
      return [take()];
    },
  };
}

export function createBoundedLineDecoder(
  maxLineBytes?: number,
  requireFinalNewline = false,
): BoundedLineDecoder {
  const { push, end } = createLineSplitter(maxLineBytes, requireFinalNewline);
  return { push, end };
}

/** Every chunk of a byte source; the source is cancelled or returned on every exit path. */
async function* chunksOf(
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
        const chunk = await reader.read();
        signal?.throwIfAborted();
        if (chunk.done) return;
        yield chunk.value;
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
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

/** Bounded, fatal-UTF-8 line reader shared by the NDJSON and SSE parsers. */
export async function* readBoundedUtf8Lines(
  source: StreamByteSource,
  maxLineBytes?: number,
  requireFinalNewline = false,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const splitter = createLineSplitter(maxLineBytes, requireFinalNewline);
  // An abort stops the lines of a chunk already read as well: the caller that aborted is not
  // handed another value.
  for await (const chunk of chunksOf(source, signal)) {
    for (const line of splitter.lines(chunk)) {
      signal?.throwIfAborted();
      yield line;
    }
  }
  for (const line of splitter.end()) {
    signal?.throwIfAborted();
    yield line;
  }
}
