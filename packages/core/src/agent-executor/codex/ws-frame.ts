import { randomBytes } from 'node:crypto';

const MAX_WS_FRAGMENTS = 1024;
const MAX_CONTROL_PAYLOAD_BYTES = 125;

/** Compute the encoded wire byte length of a masked client-to-server RFC 6455 frame. */
export function maskedWsFrameByteLength(payloadBytes: number): number {
  const headerLen = payloadBytes < 126 ? 2 : payloadBytes <= 0xffff ? 4 : 10;
  return headerLen + 4 + payloadBytes;
}

/** Encode a single masked client-to-server RFC 6455 WebSocket frame. */
export function encodeMaskedWsFrame(opcode: number, payload: Uint8Array): Buffer {
  const len = payload.byteLength;
  const headerLen = len < 126 ? 2 : len <= 0xffff ? 4 : 10;
  const frame = Buffer.allocUnsafe(headerLen + 4 + len);
  frame[0] = 0x80 | (opcode & 0x0f);
  if (len < 126) {
    frame[1] = 0x80 | len;
  } else if (len <= 0xffff) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(len, 2);
  } else {
    frame[1] = 0x80 | 127;
    const hi = Math.floor(len / 0x1_0000_0000);
    const lo = len >>> 0;
    frame.writeUInt32BE(hi, 2);
    frame.writeUInt32BE(lo, 6);
  }
  const mask = randomBytes(4);
  frame[headerLen] = mask[0] ?? 0;
  frame[headerLen + 1] = mask[1] ?? 0;
  frame[headerLen + 2] = mask[2] ?? 0;
  frame[headerLen + 3] = mask[3] ?? 0;
  const bodyOffset = headerLen + 4;
  for (let i = 0; i < len; i += 1) {
    frame[bodyOffset + i] = (payload[i] ?? 0) ^ (mask[i & 3] ?? 0);
  }
  return frame;
}

/** Linear-time byte queue avoiding O(N^2) Buffer.concat copies across multi-chunk frames. */
function createByteQueue() {
  const chunks: Buffer[] = [];
  let headOffset = 0;
  let total = 0;

  return {
    get length() {
      return total;
    },
    push(chunk: Buffer) {
      if (chunk.byteLength === 0) return;
      chunks.push(chunk);
      total += chunk.byteLength;
    },
    peekBytes(count: number): Buffer {
      const first = chunks[0];
      if (first !== undefined && first.byteLength - headOffset >= count) {
        return first.subarray(headOffset, headOffset + count);
      }
      const out = Buffer.allocUnsafe(count);
      let written = 0;
      let idx = 0;
      let off = headOffset;
      while (written < count && idx < chunks.length) {
        const cur = chunks[idx];
        if (cur === undefined) break;
        const take = Math.min(cur.byteLength - off, count - written);
        cur.copy(out, written, off, off + take);
        written += take;
        idx += 1;
        off = 0;
      }
      return out;
    },
    consume(count: number): Buffer {
      const out = Buffer.allocUnsafe(count);
      let written = 0;
      while (written < count && chunks.length > 0) {
        const cur = chunks[0];
        if (cur === undefined) break;
        const avail = cur.byteLength - headOffset;
        const take = Math.min(avail, count - written);
        cur.copy(out, written, headOffset, headOffset + take);
        written += take;
        total -= take;
        if (take === avail) {
          chunks.shift();
          headOffset = 0;
        } else {
          headOffset += take;
        }
      }
      return out;
    },
    skip(count: number) {
      let left = count;
      while (left > 0 && chunks.length > 0) {
        const cur = chunks[0];
        if (cur === undefined) break;
        const avail = cur.byteLength - headOffset;
        if (left >= avail) {
          chunks.shift();
          headOffset = 0;
          total -= avail;
          left -= avail;
        } else {
          headOffset += left;
          total -= left;
          left = 0;
        }
      }
    },
    clear() {
      chunks.length = 0;
      headOffset = 0;
      total = 0;
    },
  };
}

/** Bounded streaming RFC 6455 server-to-client frame decoder (UTF-8 text + control frames). */
export function createWsFrameDecoder(handlers: {
  maxFrameBytes: number;
  onMessage(text: string): void;
  onPing(payload: Buffer): void;
  onClose(code: number | undefined, reason: string): void;
  onProtocolError(message: string): void;
}): { push(chunk: Buffer): void } {
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const queue = createByteQueue();
  let fragments: Buffer[] | undefined;
  let fragmentBytes = 0;
  let stopped = false;

  const fail = (message: string) => {
    stopped = true;
    queue.clear();
    fragments = undefined;
    fragmentBytes = 0;
    handlers.onProtocolError(message);
  };

  return {
    push(chunk) {
      if (stopped || chunk.byteLength === 0) return;
      queue.push(chunk);
      while (!stopped && queue.length >= 2) {
        const head2 = queue.peekBytes(2);
        const b0 = head2[0] ?? 0;
        const b1 = head2[1] ?? 0;
        if ((b0 & 0x70) !== 0) return fail('Server WebSocket frame set reserved RSV bits');
        if ((b1 & 0x80) !== 0) return fail('Server WebSocket frame must not be masked');
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const len7 = b1 & 0x7f;
        let headerLen = 2;
        let payloadLen = len7;
        if (len7 === 126) {
          if (queue.length < 4) break;
          headerLen = 4;
          payloadLen = queue.peekBytes(4).readUInt16BE(2);
        } else if (len7 === 127) {
          if (queue.length < 10) break;
          headerLen = 10;
          const head10 = queue.peekBytes(10);
          const hi = head10.readUInt32BE(2);
          const lo = head10.readUInt32BE(6);
          if ((hi & 0x8000_0000) !== 0)
            return fail('WebSocket 64-bit frame length has MSB set');
          payloadLen = hi * 0x1_0000_0000 + lo;
        }
        if (opcode >= 0x8) {
          if (!fin) return fail('Control WebSocket frame must not be fragmented');
          if (payloadLen > MAX_CONTROL_PAYLOAD_BYTES) {
            return fail(
              `Control WebSocket frame payload (${payloadLen} bytes) exceeds 125 bytes`,
            );
          }
          if (opcode !== 0x8 && opcode !== 0x9 && opcode !== 0xa) {
            return fail(`Unsupported WebSocket control opcode 0x${opcode.toString(16)}`);
          }
        } else {
          if (opcode !== 0x0 && opcode !== 0x1) {
            return fail(`Unsupported WebSocket data opcode 0x${opcode.toString(16)}`);
          }
          if (!Number.isSafeInteger(payloadLen) || payloadLen > handlers.maxFrameBytes) {
            return fail(
              `WebSocket frame payload (${payloadLen} bytes) exceeds maxFrameBytes (${handlers.maxFrameBytes})`,
            );
          }
          if (opcode === 0x1 && fragments !== undefined) {
            return fail('Interleaved WebSocket text frame during fragmented message');
          }
          if (opcode === 0x0 && fragments === undefined) {
            return fail('Unexpected WebSocket continuation frame without an active message');
          }
          if (fragments !== undefined) {
            if (fragments.length + 1 > MAX_WS_FRAGMENTS) {
              return fail(`Fragmented WebSocket message exceeded ${MAX_WS_FRAGMENTS} frames`);
            }
            if (fragmentBytes + payloadLen > handlers.maxFrameBytes) {
              return fail(
                `Fragmented WebSocket message exceeded maxFrameBytes (${handlers.maxFrameBytes})`,
              );
            }
          }
        }
        if (queue.length < headerLen + payloadLen) break;
        queue.skip(headerLen);
        const payload = queue.consume(payloadLen);
        if (opcode === 0x9) {
          handlers.onPing(payload);
        } else if (opcode === 0xa) {
          // Pong frame ignored.
        } else if (opcode === 0x8) {
          if (payload.byteLength === 1)
            return fail('WebSocket close frame payload cannot be 1 byte');
          const code = payload.byteLength >= 2 ? payload.readUInt16BE(0) : undefined;
          let reason = '';
          if (payload.byteLength > 2) {
            try {
              reason = utf8.decode(payload.subarray(2));
            } catch {
              return fail('WebSocket close frame reason is not valid UTF-8');
            }
          }
          stopped = true;
          queue.clear();
          fragments = undefined;
          fragmentBytes = 0;
          handlers.onClose(code, reason);
          return;
        } else if (opcode === 0x1) {
          if (fin) {
            let text: string;
            try {
              text = utf8.decode(payload);
            } catch {
              return fail('WebSocket text frame is not valid UTF-8');
            }
            handlers.onMessage(text);
          } else {
            fragments = [payload];
            fragmentBytes = payload.byteLength;
          }
        } else if (opcode === 0x0 && fragments !== undefined) {
          fragments.push(payload);
          fragmentBytes += payload.byteLength;
          if (fin) {
            const combined = Buffer.concat(fragments, fragmentBytes);
            fragments = undefined;
            fragmentBytes = 0;
            let text: string;
            try {
              text = utf8.decode(combined);
            } catch {
              return fail('Reassembled WebSocket text message is not valid UTF-8');
            }
            handlers.onMessage(text);
          }
        }
      }
    },
  };
}
