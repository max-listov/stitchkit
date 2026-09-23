import type { MultipartDescriptor, MultipartFilePolicy } from '../contract/client-types';
import { badRequest } from '../contract/errors';
import {
  decoder,
  type MultipartPart,
  MultipartStreamReader,
  parseBoundary,
} from './multipart-reader';
import type { MultipartReceiver, MultipartReceiverResult } from './types';

const DEFAULT_MAX_REQUEST_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_FIELD_BYTES = 1024 * 1024;
const DEFAULT_MAX_PARTS = 1000;
export interface MultipartLifecycle {
  rollback(): Promise<void>;
}

/** Parsed multipart fields, files and rollback ownership for streamed handles. */
export interface MultipartResult extends MultipartLifecycle {
  files: Record<string, unknown>;
  fields: unknown;
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
