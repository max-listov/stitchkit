import { ConnectionResponseTooLargeError } from './errors';

export interface SseFrame {
  event: string;
  data: string;
}

/** Bounds every frame before concatenation; a finite response also has a total cap. */
export async function* readSseFrames(
  response: Response,
  maxBytes: number,
  connectionName: string,
  totalLimit = false,
): AsyncGenerator<SseFrame> {
  if (!response.body) throw new Error('MCP stream ended with no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (totalLimit) {
        bytes += value.byteLength;
        if (bytes > maxBytes)
          throw new ConnectionResponseTooLargeError(connectionName, maxBytes);
      }
      // Decode bounded chunks so a single oversized network chunk cannot grow the buffer unchecked.
      for (let offset = 0; offset < value.byteLength; offset += 1024) {
        buffer += decoder.decode(value.subarray(offset, offset + 1024), { stream: true });
        let match = /\r?\n\r?\n/.exec(buffer);
        while (match) {
          const frame = buffer.slice(0, match.index);
          if (new TextEncoder().encode(frame).byteLength > maxBytes)
            throw new ConnectionResponseTooLargeError(connectionName, maxBytes);
          buffer = buffer.slice(match.index + match[0].length);
          let event = 'message';
          const data: string[] = [];
          for (const line of frame.split(/\r?\n/)) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
          }
          yield { event, data: data.join('\n') };
          match = /\r?\n\r?\n/.exec(buffer);
        }
        if (new TextEncoder().encode(buffer).byteLength > maxBytes)
          throw new ConnectionResponseTooLargeError(connectionName, maxBytes);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
