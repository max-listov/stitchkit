import { type ManagedFileRef, ManagedFileRefSchema } from '../contract/file-ref';
import { raceAbort } from '../internal/abort-race';
import { type StagedFile, writeAllBytes } from '../internal/atomic-file';
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
    const inspected = await raceAbort(
      Promise.resolve().then(() => inspector({ ...input, signal })),
      signal,
    );
    return ManagedFileInspectionSchema.parse(inspected);
  } catch (error) {
    if (outerSignal?.aborted) throw outerSignal.reason;
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

export async function writeSource(
  file: StagedFile,
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
    await writeAllBytes(file, chunk);
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
