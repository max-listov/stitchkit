import { ConnectionResponseTooLargeError } from './errors';
import { awaitConnection } from './limits';
import type { ConnectionReadContext } from './operation-limits';

export interface SseFrame {
  event: string;
  data: string;
}

interface SseReadOptions {
  totalLimit?: boolean;
  context?: ConnectionReadContext;
  currentContext?: () => ConnectionReadContext;
  onChunk?: (bytes: number) => void;
  signal?: AbortSignal;
}

/** Raw UTF-8 bytes include frame delimiters; partial code points never change the count. */
export async function* readSseFrames(
  response: Response,
  maxBytes: number,
  connectionName: string,
  options: SseReadOptions = {},
): AsyncGenerator<SseFrame> {
  if (!response.body) throw new Error('MCP stream ended with no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const signal = options.signal ?? options.context?.signal;
  const cancel = () => void reader.cancel(signal?.reason).catch(() => undefined);
  signal?.addEventListener('abort', cancel, { once: true });
  let pieces: Uint8Array[] = [];
  let frameBytes = 0;
  let tail = 0;
  let bytes = 0;
  const context = () => options.currentContext?.() ?? options.context;
  const tooLarge = (observedReadBytes: number) => {
    const current = context();
    return new ConnectionResponseTooLargeError(
      connectionName,
      current?.maxResponseBytes ?? maxBytes,
      { ...current, observedReadBytes },
    );
  };
  try {
    for (;;) {
      const { done, value } = await awaitConnection(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (options.onChunk) options.onChunk(value.byteLength);
      else if (options.context) options.context.observedReadBytes += value.byteLength;
      if (options.totalLimit && bytes > (context()?.maxResponseBytes ?? maxBytes)) {
        throw tooLarge(bytes);
      }
      let start = 0;
      let ceiling = context()?.maxResponseBytes ?? maxBytes;
      for (let offset = 0; offset < value.byteLength; offset++) {
        const byte = value[offset];
        if (byte === undefined) continue;
        frameBytes++;
        if (frameBytes > ceiling) throw tooLarge(frameBytes);
        tail = ((tail << 8) | byte) >>> 0;
        if ((tail & 0xffff) !== 0x0a0a && (tail & 0xffffff) !== 0x0a0d0a) continue;
        pieces.push(value.subarray(start, offset + 1));
        let text = '';
        for (const piece of pieces) text += decoder.decode(piece, { stream: true });
        text += decoder.decode();
        pieces = [];
        frameBytes = 0;
        tail = 0;
        start = offset + 1;
        yield parseSseFrame(text);
        ceiling = context()?.maxResponseBytes ?? maxBytes;
        signal?.throwIfAborted();
      }
      if (start < value.byteLength) {
        pieces.push(value.subarray(start));
      }
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

function parseSseFrame(text: string): SseFrame {
  let event = 'message';
  const data: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  return { event, data: data.join('\n') };
}
