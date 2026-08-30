import type { MultipartDescriptor, MultipartFilePolicy } from '../contract';
import { badRequest } from '../contract';
import { isUnsafeKey } from '../internal/safe-json';
import type { MultipartReceiver, MultipartReceiverResult } from './types';

const DEFAULT_MAX_REQUEST_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_FIELD_BYTES = 1024 * 1024;
const DEFAULT_MAX_HEADER_BYTES = 64 * 1024;
const DEFAULT_MAX_PARTS = 1000;
const CRLF = new Uint8Array([13, 10]);
const HEADER_END = new Uint8Array([13, 10, 13, 10]);
const decoder = new TextDecoder();
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

export interface MultipartLifecycle {
  rollback(): Promise<void>;
}

/** Parsed multipart fields, files and rollback ownership for streamed handles. */
export interface MultipartResult extends MultipartLifecycle {
  files: Record<string, unknown>;
  fields: unknown;
}

interface ParsedHeaders {
  name: string;
  filename?: string;
  contentType?: string;
  declaredSize?: number;
}

interface MultipartPart extends ParsedHeaders {
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

function parseBoundary(req: Request): string {
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

class MultipartStreamReader {
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

function matchesContentType(contentType: string, accepted: readonly string[]): boolean {
  const normalized = contentType.toLowerCase();
  return accepted.some((candidate) => {
    const policy = candidate.toLowerCase();
    return policy.endsWith('/*')
      ? normalized.startsWith(policy.slice(0, -1))
      : normalized === policy;
  });
}

function limitedStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  label: string,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let total = 0;
  const cancelReader = (reason?: unknown): void => {
    void reader.cancel(reason).catch(() => {
      // The limit or abort error remains authoritative.
    });
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal.aborted) {
        cancelReader(signal.reason);
        controller.error(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        return;
      }
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          reader.releaseLock();
          return;
        }
        total += result.value.length;
        if (total > maxBytes) {
          cancelReader();
          badRequest(`${label} exceeds ${maxBytes} bytes`);
        }
        controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      cancelReader(reason);
    },
  });
}

async function collectFile(
  part: MultipartPart,
  stream: ReadableStream<Uint8Array>,
): Promise<File> {
  const chunks: ArrayBuffer[] = [];
  const reader = stream.getReader();
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(Uint8Array.from(result.value).buffer);
  }
  return new File(chunks, part.filename ?? 'upload', {
    type: part.contentType ?? 'application/octet-stream',
  });
}

async function readText(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.length;
    if (total > maxBytes) {
      await reader.cancel();
      badRequest(`Multipart text field exceeds ${maxBytes} bytes`);
    }
    chunks.push(result.value);
  }
  const value = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    value.set(chunk, offset);
    offset += chunk.length;
  }
  return decoder.decode(value);
}

function required(policy: MultipartFilePolicy): boolean {
  return policy.required !== false;
}

/**
 * Parse a typed multipart descriptor. Buffered delivery materialises `File`
 * values; streaming delivery invokes consumer receivers as each part arrives.
 */
export async function parseMultipart(
  req: Request,
  descriptor: MultipartDescriptor,
  fieldsSchema?: { parse(value: unknown): unknown },
  receivers?: Record<string, MultipartReceiver>,
): Promise<MultipartResult> {
  const maxRequestBytes = descriptor.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const contentLength = Number(req.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxRequestBytes) {
    badRequest(`Multipart request exceeds ${maxRequestBytes} bytes`);
  }
  const boundary = parseBoundary(req);
  const parser = new MultipartStreamReader(req, boundary, maxRequestBytes);
  const fields: Record<string, string> = {};
  const files: Record<string, unknown> = {};
  const counts = new Map<string, number>();
  const cleanups: Array<() => void | Promise<void>> = [];
  let rolledBack = false;
  const rollback = async (): Promise<void> => {
    if (rolledBack) return;
    rolledBack = true;
    for (let index = cleanups.length - 1; index >= 0; index -= 1) {
      try {
        await cleanups[index]?.();
      } catch (error) {
        console.error('[stitchkit] multipart receiver cleanup failed', error);
      }
    }
  };

  try {
    await parser.start();
    let partCount = 0;
    while (true) {
      const part = await parser.nextPart();
      if (!part) break;
      partCount += 1;
      if (partCount > DEFAULT_MAX_PARTS) badRequest('Too many multipart parts');
      const policy = descriptor.files[part.name];
      const isFile = part.filename !== undefined || part.contentType !== undefined;
      if (!isFile) {
        if (policy) badRequest(`Multipart file field "${part.name}" must contain a file`);
        if (Object.hasOwn(fields, part.name)) {
          badRequest(`Duplicate multipart text field: ${part.name}`);
        }
        fields[part.name] = await readText(
          part.stream,
          descriptor.maxFieldBytes ?? DEFAULT_MAX_FIELD_BYTES,
        );
        continue;
      }
      if (!policy) badRequest(`Unexpected multipart file field: ${part.name}`);
      const count = (counts.get(part.name) ?? 0) + 1;
      counts.set(part.name, count);
      const maxFiles = policy.multiple === true ? (policy.maxFiles ?? DEFAULT_MAX_PARTS) : 1;
      if (count > maxFiles) badRequest(`Too many files for multipart field: ${part.name}`);
      const contentType = part.contentType ?? '';
      if (policy.contentTypes && !matchesContentType(contentType, policy.contentTypes)) {
        badRequest(`Unsupported content type for multipart field "${part.name}"`);
      }
      const maxFileBytes = policy.maxBytes ?? maxRequestBytes;
      if (part.declaredSize !== undefined && part.declaredSize > maxFileBytes) {
        badRequest(`Multipart field "${part.name}" exceeds ${maxFileBytes} bytes`);
      }
      const stream = limitedStream(
        part.stream,
        maxFileBytes,
        `Multipart field "${part.name}"`,
        req.signal,
      );
      let value: unknown;
      if (descriptor.delivery === 'stream') {
        const receiver = receivers?.[part.name];
        if (!receiver) badRequest(`Missing multipart receiver for field: ${part.name}`);
        const result: MultipartReceiverResult<unknown> = await receiver({
          metadata: {
            field: part.name,
            filename: part.filename ?? 'upload',
            contentType: contentType || 'application/octet-stream',
            size: part.declaredSize,
          },
          stream,
          signal: req.signal,
        });
        cleanups.push(result.cleanup);
        if (!part.consumed()) {
          await stream.cancel();
          badRequest(`Multipart receiver for "${part.name}" did not consume its stream`);
        }
        value = result.value;
      } else {
        value = await collectFile(part, stream);
      }
      if (policy.multiple === true) {
        const existing = files[part.name];
        if (Array.isArray(existing)) existing.push(value);
        else files[part.name] = [value];
      } else {
        files[part.name] = value;
      }
    }

    for (const [field, policy] of Object.entries(descriptor.files)) {
      const count = counts.get(field) ?? 0;
      if (required(policy) && count === 0)
        badRequest(`Missing multipart file field: ${field}`);
      if (policy.multiple === true && count === 0 && !required(policy)) files[field] = [];
    }

    return {
      files,
      fields: fieldsSchema ? fieldsSchema.parse(fields) : fields,
      rollback,
    };
  } catch (error) {
    parser.cancel(error);
    await rollback();
    throw error;
  } finally {
    parser.release();
  }
}
