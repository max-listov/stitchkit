import type { open } from 'node:fs/promises';
import { type ManagedFileRef, ManagedFileRefSchema } from '../contract/file-ref';
import {
  ManagedFileError,
  type ManagedFileInspection,
  type ManagedFileInspectionInput,
  type ManagedFileInspector,
} from './boundary';

const ManagedFileInspectionSchema = ManagedFileRefSchema.pick({
  mediaType: true,
  name: true,
});

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

function raceWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;
    const settle = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      complete();
    };
    const onAbort = (): void => settle(() => rejectPromise(abortReason(signal)));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    operation.then(
      (value) => settle(() => resolvePromise(value)),
      (error: unknown) => settle(() => rejectPromise(error)),
    );
  });
}

export async function inspectFile(
  inspector: ManagedFileInspector | undefined,
  input: Omit<ManagedFileInspectionInput, 'signal'>,
  timeoutMs: number,
  outerSignal?: AbortSignal,
): Promise<ManagedFileInspection> {
  if (!inspector) return {};
  outerSignal?.throwIfAborted();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = outerSignal ? AbortSignal.any([outerSignal, timeoutSignal]) : timeoutSignal;
  try {
    const inspected = await raceWithSignal(
      Promise.resolve().then(() => inspector({ ...input, signal })),
      signal,
    );
    return ManagedFileInspectionSchema.parse(inspected);
  } catch (error) {
    if (outerSignal?.aborted) throw abortReason(outerSignal);
    throw new ManagedFileError(
      'FILE_INSPECTION_REJECTED',
      'managed file rejected by inspection',
      { cause: error },
    );
  }
}

export function inspectedRef(
  path: string,
  size: number,
  inspection: ManagedFileInspection,
  fallback: { mediaType?: string; name?: string } = {},
): ManagedFileRef {
  const mediaType = inspection.mediaType ?? fallback.mediaType;
  const name = inspection.name ?? fallback.name;
  const parsed = ManagedFileRefSchema.safeParse({
    path,
    size,
    ...(mediaType ? { mediaType } : {}),
    ...(name ? { name } : {}),
  });
  if (!parsed.success) {
    throw new ManagedFileError(
      'FILE_INSPECTION_REJECTED',
      'managed file rejected by inspection',
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

export async function readHandle(
  handle: Awaited<ReturnType<typeof open>>,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    signal?.throwIfAborted();
    const capacity = Math.min(64 * 1024, maxBytes + 1 - total);
    if (capacity <= 0) {
      throw new ManagedFileError('FILE_TOO_LARGE', `file exceeds the ${maxBytes}-byte cap`);
    }
    const chunk = new Uint8Array(capacity);
    const { bytesRead } = await handle.read(chunk, 0, capacity);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) {
      throw new ManagedFileError('FILE_TOO_LARGE', `file exceeds the ${maxBytes}-byte cap`);
    }
    chunks.push(chunk.subarray(0, bytesRead));
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function writeChunk(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
    if (bytesWritten === 0) throw new Error('zero-byte managed-file write');
    offset += bytesWritten;
  }
}

export async function writeSource(
  handle: Awaited<ReturnType<typeof open>>,
  source: Uint8Array | ReadableStream<Uint8Array>,
  maxBytes: number,
  inspectionBytes: number,
  signal?: AbortSignal,
): Promise<{ size: number; prefix: Uint8Array }> {
  let size = 0;
  const prefixChunks: Uint8Array[] = [];
  let prefixSize = 0;
  const consume = async (chunk: Uint8Array): Promise<void> => {
    signal?.throwIfAborted();
    size += chunk.byteLength;
    if (size > maxBytes) {
      throw new ManagedFileError('FILE_TOO_LARGE', `file exceeds the ${maxBytes}-byte cap`);
    }
    if (prefixSize < inspectionBytes) {
      const kept = chunk.subarray(0, inspectionBytes - prefixSize);
      prefixChunks.push(kept);
      prefixSize += kept.byteLength;
    }
    await writeChunk(handle, chunk);
  };

  if (source instanceof Uint8Array) {
    await consume(source);
  } else {
    const reader = source.getReader();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        await consume(result.value);
      }
    } catch (error) {
      await reader.cancel(error).catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  const prefix = new Uint8Array(prefixSize);
  let offset = 0;
  for (const chunk of prefixChunks) {
    prefix.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { size, prefix };
}
