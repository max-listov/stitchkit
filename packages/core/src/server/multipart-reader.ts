import { badRequest } from '../contract/errors';
import { isUnsafeKey } from '../internal/safe-json';

export const DEFAULT_MAX_HEADER_BYTES = 64 * 1024;
const CRLF = new Uint8Array([13, 10]);
const HEADER_END = new Uint8Array([13, 10, 13, 10]);
export const decoder = new TextDecoder();
const headerDecoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function hasControl(value: string, allowTab = false): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if ((code < 32 && !(allowTab && code === 9)) || code === 127) return true;
  }
  return false;
}

function trimWhitespace(value: string): string {
  return value.replace(/^[ \t]+|[ \t]+$/g, '');
}

export interface ParsedHeaders {
  name: string;
  filename?: string;
  contentType?: string;
  declaredSize?: number;
}

export interface MultipartPart extends ParsedHeaders {
  stream: ReadableStream<Uint8Array>;
  consumed(): boolean;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

function startsWithBytes(value: Uint8Array, prefix: Uint8Array): boolean {
  if (value.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (value[index] !== prefix[index]) return false;
  }
  return true;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right.slice();
  if (right.length === 0) return left.slice();
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left);
  joined.set(right, left.length);
  return joined;
}

export function parseBoundary(req: Request): string {
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    badRequest('Request body must be multipart/form-data');
  }
  const match = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary || boundary.length > 200) badRequest('Invalid multipart boundary');
  return boundary;
}

function parseDisposition(value: string | undefined): { name: string; filename?: string } {
  if (!value) badRequest('Invalid multipart disposition');
  const separator = value.indexOf(';');
  const kind = separator < 0 ? value : value.slice(0, separator);
  if (trimWhitespace(kind).toLowerCase() !== 'form-data') {
    badRequest('Invalid multipart disposition');
  }
  const parameters = new Map<string, string>();
  let rest = separator < 0 ? '' : value.slice(separator);
  while (rest.length > 0) {
    const match =
      /^;[ \t]*([^=; \t]+)[ \t]*=[ \t]*(?:"((?:[^"\\]|\\.)*)"|([^; \t]+))[ \t]*/.exec(rest);
    if (!match?.[1]) badRequest('Invalid multipart disposition parameter');
    const key = match[1].toLowerCase();
    if (!TOKEN.test(key) || parameters.has(key)) {
      badRequest('Invalid or duplicate multipart disposition parameter');
    }
    const quoted = match[2];
    const raw = match[3] ?? '';
    if (quoted === undefined && !TOKEN.test(raw)) {
      badRequest('Invalid multipart disposition parameter');
    }
    const decoded = quoted === undefined ? raw : quoted.replace(/\\(.)/g, '$1');
    if (hasControl(decoded)) badRequest('Invalid multipart disposition parameter');
    parameters.set(key, decoded);
    rest = rest.slice(match[0].length);
  }
  const name = parameters.get('name');
  let filename = parameters.get('filename');
  const extended = parameters.get('filename*');
  if (extended !== undefined) {
    const match = /^utf-8'[A-Za-z0-9-]*'((?:[!#$&+.^_`|~0-9A-Za-z-]|%[0-9A-Fa-f]{2})*)$/i.exec(
      extended,
    );
    if (!match) badRequest('Invalid multipart extended filename');
    try {
      filename = decodeURIComponent(match[1] ?? '');
    } catch {
      badRequest('Invalid multipart extended filename');
    }
    if (hasControl(filename)) badRequest('Invalid multipart extended filename');
  }
  if (!name || isUnsafeKey(name)) badRequest('Invalid multipart field name');
  return filename === undefined ? { name } : { name, filename };
}

function parsePartHeaders(bytes: Uint8Array): ParsedHeaders {
  let text: string;
  try {
    text = headerDecoder.decode(bytes);
  } catch {
    badRequest('Invalid multipart headers');
  }
  // MIME part metadata is UTF-8, not the ByteString HTTP Headers boundary.
  // The reader already caps the entire block at DEFAULT_MAX_HEADER_BYTES.
  const headers = new Map<string, string>();
  for (const line of text.split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) badRequest('Invalid multipart header');
    const name = line.slice(0, separator).toLowerCase();
    const value = trimWhitespace(line.slice(separator + 1));
    if (!TOKEN.test(name) || hasControl(value, true)) {
      badRequest('Invalid multipart header');
    }
    if (headers.has(name)) badRequest('Duplicate multipart header');
    headers.set(name, value);
  }
  const disposition = parseDisposition(headers.get('content-disposition') ?? undefined);
  const rawContentType = headers.get('content-type');
  const contentType = rawContentType?.split(';', 1)[0]?.trim().toLowerCase();
  const rawSize = headers.get('content-length');
  if (rawSize !== undefined && !/^[0-9]+$/.test(rawSize)) {
    badRequest('Invalid multipart part content-length');
  }
  const declaredSize = rawSize === undefined ? undefined : Number(rawSize);
  if (
    declaredSize !== undefined &&
    (!Number.isSafeInteger(declaredSize) || declaredSize < 0)
  ) {
    badRequest('Invalid multipart part content-length');
  }
  return { ...disposition, contentType, declaredSize };
}

export class MultipartStreamReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #delimiter: Uint8Array;
  readonly #initialBoundary: Uint8Array;
  readonly #maxRequestBytes: number;
  #buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
  #readBytes = 0;
  #sourceDone = false;
  #terminal = false;
  #activePart = false;

  constructor(req: Request, boundary: string, maxRequestBytes: number) {
    if (!req.body) badRequest('Multipart request body is empty');
    this.#reader = req.body.getReader();
    this.#delimiter = encoder.encode(`\r\n--${boundary}`);
    this.#initialBoundary = encoder.encode(`--${boundary}`);
    this.#maxRequestBytes = maxRequestBytes;
  }

  async start(): Promise<void> {
    await this.#ensure(this.#initialBoundary.length + 2);
    if (!startsWithBytes(this.#buffer, this.#initialBoundary)) {
      badRequest('Malformed multipart body');
    }
    this.#consume(this.#initialBoundary.length);
    await this.#consumeBoundarySuffix();
  }

  async nextPart(): Promise<MultipartPart | null> {
    if (this.#activePart) badRequest('Multipart part stream was not fully consumed');
    if (this.#terminal) return null;
    const header = await this.#readUntil(HEADER_END, DEFAULT_MAX_HEADER_BYTES);
    const parsed = parsePartHeaders(header);
    this.#activePart = true;
    let ended = false;
    const stream = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (ended) {
          controller.close();
          return;
        }
        try {
          const chunk = await this.#readPartChunk();
          if (chunk.value.length > 0) controller.enqueue(chunk.value);
          if (chunk.end) {
            ended = true;
            controller.close();
          }
        } catch (error) {
          controller.error(error);
          this.cancel(error);
        }
      },
      cancel: (reason) => {
        this.cancel(reason);
      },
    });
    return { ...parsed, stream, consumed: () => ended };
  }

  cancel(reason?: unknown): void {
    void this.#reader.cancel(reason).catch(() => {
      // The original parse/receiver error remains authoritative.
    });
  }

  release(): void {
    this.#reader.releaseLock();
  }

  async #readPartChunk(): Promise<{ value: Uint8Array; end: boolean }> {
    while (true) {
      const boundaryIndex = indexOfBytes(this.#buffer, this.#delimiter);
      if (boundaryIndex >= 0) {
        const value = this.#buffer.slice(0, boundaryIndex);
        this.#consume(boundaryIndex + this.#delimiter.length);
        await this.#consumeBoundarySuffix();
        this.#activePart = false;
        return { value, end: true };
      }

      const retained = this.#delimiter.length - 1;
      if (this.#buffer.length > retained) {
        const emitLength = this.#buffer.length - retained;
        const value = this.#buffer.slice(0, emitLength);
        this.#consume(emitLength);
        return { value, end: false };
      }
      if (this.#sourceDone) badRequest('Incomplete multipart body');
      await this.#readMore();
    }
  }

  async #consumeBoundarySuffix(): Promise<void> {
    await this.#ensure(2);
    if (this.#buffer[0] === 45 && this.#buffer[1] === 45) {
      this.#consume(2);
      this.#terminal = true;
      if (startsWithBytes(this.#buffer, CRLF)) this.#consume(2);
      return;
    }
    if (!startsWithBytes(this.#buffer, CRLF)) badRequest('Malformed multipart boundary');
    this.#consume(2);
  }

  async #readUntil(marker: Uint8Array, maxBytes: number): Promise<Uint8Array> {
    while (true) {
      const index = indexOfBytes(this.#buffer, marker);
      if (index >= 0) {
        if (index > maxBytes) badRequest('Multipart part headers are too large');
        const value = this.#buffer.slice(0, index);
        this.#consume(index + marker.length);
        return value;
      }
      if (this.#buffer.length > maxBytes) badRequest('Multipart part headers are too large');
      if (this.#sourceDone) badRequest('Incomplete multipart headers');
      await this.#readMore();
    }
  }

  async #ensure(length: number): Promise<void> {
    while (this.#buffer.length < length && !this.#sourceDone) await this.#readMore();
    if (this.#buffer.length < length) badRequest('Incomplete multipart body');
  }

  async #readMore(): Promise<void> {
    const result = await this.#reader.read();
    if (result.done) {
      this.#sourceDone = true;
      return;
    }
    this.#readBytes += result.value.length;
    if (this.#readBytes > this.#maxRequestBytes) {
      this.cancel();
      badRequest(`Multipart request exceeds ${this.#maxRequestBytes} bytes`);
    }
    this.#buffer = concatBytes(this.#buffer, result.value);
  }

  #consume(length: number): void {
    this.#buffer = this.#buffer.slice(length);
  }
}
