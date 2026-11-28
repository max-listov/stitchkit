import { chunksOf } from '../internal/stream-chunks';
import { AgentProviderError, AgentProviderStreamCutError } from './provider-failure';
import { detachProviderBodyAbortGuard } from './provider-http';

export const DEFAULT_MAX_SSE_EVENT_BYTES = 16 * 1024 * 1024;

function utf8ByteLength(text: string): number {
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

export type SseFrame =
  | { readonly kind: 'ping' }
  | {
      readonly kind: 'event';
      readonly event?: string;
      readonly id?: string;
      readonly data: string;
    };

export interface ParseSseOptions {
  readonly provider: string;
  readonly maxEventBytes?: number;
  readonly signal?: AbortSignal;
}

/**
 * WHATWG-compliant O(N) SSE frame decoder with strict memory bounds (I10).
 *
 * Handles `\r\n`, `\n`, `\r` line endings across arbitrary chunk boundaries,
 * strips at most one leading space (`0x20`) after `data:` / `event:` / `id:`,
 * emits `{ kind: 'ping' }` on keepalive comments (`: ...`), guards against
 * proxy keepalive payloads (`data: null`, `data: : keepalive`), and cancels
 * the underlying reader cleanly on exit, abort, or limit violation.
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  options: ParseSseOptions,
): AsyncGenerator<SseFrame> {
  const maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_SSE_EVENT_BYTES;
  detachProviderBodyAbortGuard(body);
  if (options.signal?.aborted) {
    void body.cancel(options.signal.reason).catch(() => undefined);
    options.signal.throwIfAborted();
  }
  const decoder = new TextDecoder();
  let pendingParts: string[] = [];
  let pendingBytes = 0;
  let skipNextLf = false;
  let eventName: string | undefined;
  let eventId: string | undefined;
  let dataLines: string[] = [];
  let eventBytes = 0;

  const stripOneSpace = (value: string): string =>
    value.startsWith(' ') ? value.slice(1) : value;

  const flushEvent = (): SseFrame | undefined => {
    if (dataLines.length === 0) {
      eventName = undefined;
      eventId = undefined;
      eventBytes = 0;
      return undefined;
    }
    const data = dataLines.join('\n');
    const frame: SseFrame = {
      kind: 'event',
      ...(eventName !== undefined && { event: eventName }),
      ...(eventId !== undefined && { id: eventId }),
      data,
    };
    dataLines = [];
    eventName = undefined;
    eventId = undefined;
    eventBytes = 0;
    const trimmed = data.trim();
    if (trimmed === '' || trimmed === 'null' || trimmed.startsWith(':')) {
      return { kind: 'ping' };
    }
    return frame;
  };

  const processLine = (line: string): SseFrame | undefined => {
    if (line.length === 0) return flushEvent();
    if (line.startsWith(':')) return { kind: 'ping' };
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const rawValue = colon === -1 ? '' : stripOneSpace(line.slice(colon + 1));
    if (field === 'data') {
      eventBytes += utf8ByteLength(rawValue) + (dataLines.length > 0 ? 1 : 0);
      if (eventBytes > maxEventBytes) {
        throw new AgentProviderError(
          `${options.provider} SSE event exceeded ${maxEventBytes} byte limit`,
          { provider: options.provider },
        );
      }
      dataLines.push(rawValue);
    } else if (field === 'event') {
      eventName = rawValue;
    } else if (field === 'id' && !rawValue.includes('\0')) {
      eventId = rawValue;
    }
    return undefined;
  };

  const drainChunk = (chunkText: string): SseFrame[] => {
    if (chunkText.length === 0) return [];
    const frames: SseFrame[] = [];
    let start = 0;
    if (skipNextLf) {
      skipNextLf = false;
      if (chunkText.charCodeAt(0) === 10) start = 1;
    }
    let lineStart = start;
    for (let i = start; i < chunkText.length; i += 1) {
      const ch = chunkText.charCodeAt(i);
      if (ch === 10 || ch === 13) {
        const tail = chunkText.slice(lineStart, i);
        if (pendingBytes + utf8ByteLength(tail) > maxEventBytes) {
          throw new AgentProviderError(
            `${options.provider} SSE line exceeded ${maxEventBytes} byte limit`,
            { provider: options.provider },
          );
        }
        let line: string;
        if (pendingParts.length > 0) {
          if (tail.length > 0) pendingParts.push(tail);
          line = pendingParts.join('');
          pendingParts = [];
          pendingBytes = 0;
        } else {
          line = tail;
        }
        const frame = processLine(line);
        if (frame !== undefined) frames.push(frame);
        if (ch === 13) {
          if (i + 1 < chunkText.length) {
            if (chunkText.charCodeAt(i + 1) === 10) i += 1;
          } else {
            skipNextLf = true;
          }
        }
        lineStart = i + 1;
      }
    }
    if (lineStart < chunkText.length) {
      const remainder = chunkText.slice(lineStart);
      pendingBytes += utf8ByteLength(remainder);
      if (pendingBytes > maxEventBytes) {
        throw new AgentProviderError(
          `${options.provider} SSE line exceeded ${maxEventBytes} byte limit`,
          { provider: options.provider },
        );
      }
      pendingParts.push(remainder);
    }
    return frames;
  };

  for await (const chunk of chunksOf(body, options.signal)) {
    const decoded = decoder.decode(chunk, { stream: true });
    for (const frame of drainChunk(decoded)) yield frame;
  }
  const finalText = decoder.decode();
  if (finalText.length > 0) {
    for (const frame of drainChunk(finalText)) yield frame;
  }
  if (pendingBytes > 0) {
    // Only emit an unterminated trailing line if it is a complete SSE field (`data: [DONE]` etc.);
    // truncated JSON payloads will be classified cleanly as `AgentProviderStreamCutError` by `parseSseJson`.
    const trailing = processLine(pendingParts.join(''));
    pendingParts = [];
    pendingBytes = 0;
    if (trailing !== undefined) yield trailing;
  }
  const remaining = flushEvent();
  if (remaining !== undefined) yield remaining;
}

/**
 * Parse one SSE JSON payload, wrapping malformed/truncated JSON as a retryable
 * `AgentProviderStreamCutError` rather than leaking an unclassified `SyntaxError`.
 */
export function parseSseJson(provider: string, data: string): unknown {
  try {
    return JSON.parse(data);
  } catch (error) {
    throw new AgentProviderStreamCutError(
      `${provider} SSE stream delivered malformed or truncated JSON payload`,
      { provider, cause: error },
    );
  }
}
