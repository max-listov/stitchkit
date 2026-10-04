import type { Stats } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { basename } from 'node:path';
import { BoundedFileReadError, readBoundedFile } from '../internal/bounded-file-read';
import type { ManagedFileInspector } from './boundary';
import {
  ManagedFileError,
  type ManagedFileReadOptions,
  type ManagedFileSource,
} from './boundary';
import { inspectedRef, inspectFile } from './file-io';

/** The neutral descriptor owner proves bytes; this adapter adds managed-file metadata. */
export async function readManagedDescriptor(
  target: string,
  path: string,
  maxBytes: number,
  options: ManagedFileReadOptions,
  inspection: { inspect?: ManagedFileInspector; bytes: number; timeoutMs: number },
  openDescriptor: (
    path: string,
    flags: number,
  ) => Promise<Pick<FileHandle, 'read' | 'close'> & { stat(): Promise<Stats> }> = open,
): Promise<ManagedFileSource> {
  let source: Awaited<ReturnType<typeof readBoundedFile>>;
  try {
    source = await readBoundedFile(target, maxBytes, options, openDescriptor);
  } catch (error) {
    if (error instanceof BoundedFileReadError)
      throw new ManagedFileError(error.code, error.message, { cause: error });
    throw error;
  }
  const inspected = await inspectFile(
    inspection.inspect,
    {
      prefix: source.bytes.slice(0, inspection.bytes),
      name: basename(path),
    },
    inspection.timeoutMs,
    options.signal,
  );
  return {
    ref: inspectedRef(path, source.bytes.byteLength, inspected),
    bytes: source.bytes,
    ...(options.observe && { observation: source.observation }),
  };
}
