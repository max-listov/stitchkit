/**
 * The HTTP/1.1 wire format the Bun socket lane speaks, as pure functions over
 * bytes: the request it writes, the response head it reads, and the body
 * framing — `Content-Length`, read-to-close or chunked with trailers — decoded
 * one step at a time. No socket and no stream here, so each framing rule can be
 * driven by a test byte by byte.
 */

/** A body never leaves the decoder in pieces larger than this. */
const MAX_BODY_CHUNK_BYTES = 64 * 1024;
const MAX_CHUNK_HEADER_BYTES = 1_024;
const CRLF = [13, 10] as const;
const CRLFCRLF = [13, 10, 13, 10] as const;

export function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right.slice();
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
}

function indexOfSequence(bytes: Uint8Array, sequence: readonly number[]): number {
  outer: for (let index = 0; index <= bytes.byteLength - sequence.length; index += 1) {
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (bytes[index + offset] !== sequence[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

/** The bytes received and not yet consumed. */
export class WireBuffer {
  private bytes: Uint8Array = new Uint8Array();

  get byteLength(): number {
    return this.bytes.byteLength;
  }

  append(data: Uint8Array): void {
    this.bytes = concatBytes(this.bytes, data);
  }

  take(count: number): Uint8Array {
    const value = this.bytes.slice(0, count);
    this.bytes = this.bytes.slice(count);
    return value;
  }

  indexOf(sequence: readonly number[]): number {
    return indexOfSequence(this.bytes, sequence);
  }

  startsWith(sequence: readonly number[]): boolean {
    return sequence.every((byte, index) => this.bytes[index] === byte);
  }
}

export function requestBytes(request: Request, body: Uint8Array | undefined): Uint8Array {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.set('host', url.host);
  headers.set('connection', 'close');
  headers.set('accept-encoding', 'identity');
  headers.delete('transfer-encoding');
  headers.delete('content-length');
  if (body !== undefined) headers.set('content-length', String(body.byteLength));
  const lines = [`${request.method} ${url.pathname}${url.search} HTTP/1.1`];
  for (const [name, value] of headers) lines.push(`${name}: ${value}`);
  const head = new TextEncoder().encode(`${lines.join('\r\n')}\r\n\r\n`);
  return body === undefined ? head : concatBytes(head, body);
}

function parseContentLength(headers: Headers): number | undefined {
  const raw = headers.get('content-length');
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw)) throw new Error('Unix response has an invalid Content-Length');
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error('Unix response Content-Length is not a safe integer');
  }
  return value;
}

export type ResponseHead = {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly contentLength: number | undefined;
  readonly chunked: boolean;
};

export type HeadStep =
  | { readonly kind: 'more' }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'malformed'; readonly error: unknown }
  | ({ readonly kind: 'head' } & ResponseHead);

/** Read the status line and headers off the wire, once they are all there. */
export function readResponseHead(wire: WireBuffer, maxHeaderBytes: number): HeadStep {
  const headerEnd = wire.indexOf(CRLFCRLF);
  if (headerEnd < 0) {
    return wire.byteLength > maxHeaderBytes ? { kind: 'too-large' } : { kind: 'more' };
  }
  if (headerEnd + 4 > maxHeaderBytes) return { kind: 'too-large' };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(wire.take(headerEnd));
  } catch (error) {
    return { kind: 'malformed', error };
  }
  wire.take(4);
  const lines = text.split('\r\n');
  const statusLine = lines.shift() ?? '';
  const matched = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(statusLine);
  if (!matched) {
    return {
      kind: 'malformed',
      error: new Error('Unix response has an invalid HTTP status line'),
    };
  }
  const headers = new Headers();
  let contentLength: number | undefined;
  try {
    for (const line of lines) {
      const separator = line.indexOf(':');
      if (separator <= 0) throw new Error('Unix response has an invalid header line');
      headers.append(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
    }
    contentLength = parseContentLength(headers);
  } catch (error) {
    return { kind: 'malformed', error };
  }
  return {
    kind: 'head',
    status: Number(matched[1]),
    statusText: matched[2] ?? '',
    headers,
    contentLength,
    chunked: headers.get('transfer-encoding')?.toLowerCase().includes('chunked') ?? false,
  };
}

export type BodyStep =
  | { readonly kind: 'data'; readonly value: Uint8Array }
  | { readonly kind: 'complete' }
  | { readonly kind: 'more' }
  | { readonly kind: 'trailers-too-large' }
  | { readonly kind: 'malformed'; readonly error: Error };

const malformed = (message: string): BodyStep => ({
  kind: 'malformed',
  error: new Error(message),
});

/**
 * Body framing, one step per call: at most one piece of data, or the answer
 * that the body is complete, needs more bytes, or is malformed.
 *
 * The framing state moves BEFORE a piece is returned. The caller enqueues it
 * into a stream whose `enqueue` may synchronously pull again, and a re-entrant
 * step must not read the chunk's CRLF delimiter as body bytes.
 */
export class BodyDecoder {
  private chunkRemaining: number | undefined;
  private expectChunkCrlf = false;
  private trailers = false;

  constructor(
    private readonly chunked: boolean,
    private remainingLength: number | undefined,
    private readonly maxHeaderBytes: number,
  ) {}

  next(wire: WireBuffer, peerEnded: boolean): BodyStep {
    return this.chunked ? this.nextChunked(wire, peerEnded) : this.nextPlain(wire, peerEnded);
  }

  private nextPlain(wire: WireBuffer, peerEnded: boolean): BodyStep {
    if (wire.byteLength > 0) {
      const permitted = this.remainingLength ?? wire.byteLength;
      const bytes = Math.min(permitted, wire.byteLength, MAX_BODY_CHUNK_BYTES);
      if (this.remainingLength !== undefined) this.remainingLength -= bytes;
      return { kind: 'data', value: wire.take(bytes) };
    }
    if (this.remainingLength === 0) return { kind: 'complete' };
    if (!peerEnded) return { kind: 'more' };
    return this.remainingLength !== undefined && this.remainingLength > 0
      ? malformed('Unix response ended before Content-Length bytes arrived')
      : { kind: 'complete' };
  }

  /** Whether a plain body has delivered every declared byte. */
  get plainComplete(): boolean {
    return !this.chunked && this.remainingLength === 0;
  }

  private nextChunked(wire: WireBuffer, peerEnded: boolean): BodyStep {
    for (;;) {
      if (this.trailers) return this.readTrailers(wire, peerEnded);
      if (this.expectChunkCrlf) {
        if (wire.byteLength < 2) {
          return peerEnded
            ? malformed('Unix chunked response ended before chunk delimiter')
            : { kind: 'more' };
        }
        if (!wire.startsWith(CRLF)) {
          return malformed('Unix chunked response has an invalid chunk delimiter');
        }
        wire.take(2);
        this.expectChunkCrlf = false;
      }
      if (this.chunkRemaining === undefined) {
        const header = this.readChunkHeader(wire, peerEnded);
        if (header !== undefined) return header;
        if (this.trailers) continue;
      }
      const remaining = this.chunkRemaining ?? 0;
      if (wire.byteLength === 0) {
        return peerEnded
          ? malformed('Unix chunked response ended inside a chunk')
          : { kind: 'more' };
      }
      const bytes = Math.min(remaining, wire.byteLength, MAX_BODY_CHUNK_BYTES);
      const value = wire.take(bytes);
      this.chunkRemaining = remaining - bytes;
      if (this.chunkRemaining === 0) {
        this.chunkRemaining = undefined;
        this.expectChunkCrlf = true;
      }
      return { kind: 'data', value };
    }
  }

  /** Read one chunk-size line; `undefined` when it was read and the chunk can proceed. */
  private readChunkHeader(wire: WireBuffer, peerEnded: boolean): BodyStep | undefined {
    const lineEnd = wire.indexOf(CRLF);
    if (lineEnd < 0) {
      if (wire.byteLength > MAX_CHUNK_HEADER_BYTES)
        return malformed('Unix chunk header is too large');
      return peerEnded
        ? malformed('Unix chunked response ended inside chunk header')
        : { kind: 'more' };
    }
    const line = new TextDecoder('ascii', { fatal: true }).decode(wire.take(lineEnd));
    wire.take(2);
    const sizeText = line.split(';', 1)[0]?.trim() ?? '';
    if (!/^[0-9a-f]+$/i.test(sizeText)) {
      return malformed('Unix chunked response has an invalid chunk size');
    }
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isSafeInteger(size)) return malformed('Unix chunk size is not a safe integer');
    if (size === 0) this.trailers = true;
    else this.chunkRemaining = size;
    return undefined;
  }

  private readTrailers(wire: WireBuffer, peerEnded: boolean): BodyStep {
    if (wire.byteLength >= 2 && wire.startsWith(CRLF)) {
      wire.take(2);
      return { kind: 'complete' };
    }
    const trailerEnd = wire.indexOf(CRLFCRLF);
    if (trailerEnd < 0) {
      if (wire.byteLength > this.maxHeaderBytes) return { kind: 'trailers-too-large' };
      return peerEnded
        ? malformed('Unix chunked response ended inside trailers')
        : { kind: 'more' };
    }
    wire.take(trailerEnd + 4);
    return { kind: 'complete' };
  }
}
