import { constants, type Stats } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ManagedFileInspector } from './boundary';
import {
  ManagedFileError,
  type ManagedFileReadOptions,
  type ManagedFileSource,
} from './boundary';
import { inspectedRef, inspectFile, readHandle } from './file-io';

/** The descriptor, rather than a preceding path stat, decides kind/link/stability. */
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
  if (options.rejectSymlinks && !constants.O_NOFOLLOW)
    throw new ManagedFileError('FILE_UNSUPPORTED', 'strict leaf nofollow is unavailable');
  // Opening a FIFO read-only can block forever before fstat can reject it.
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const handle = await openDescriptor(target, flags);
  let failed = false;
  let failure: unknown;
  let source: ManagedFileSource | undefined;
  try {
    options.signal?.throwIfAborted();
    const before = await handle.stat();
    if (!before.isFile())
      throw new ManagedFileError('FILE_NOT_REGULAR', 'managed path is not a regular file');
    if (options.singleLink && before.nlink !== 1)
      throw new ManagedFileError('FILE_UNSAFE_LINK', 'managed file has multiple links');
    if (before.size > maxBytes)
      throw new ManagedFileError('FILE_TOO_LARGE', `file exceeds the ${maxBytes}-byte cap`);
    const bytes = await readHandle(handle, maxBytes, options.signal);
    const after = options.stable || options.observe ? await handle.stat() : before;
    if (
      options.stable &&
      (before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        before.nlink !== after.nlink ||
        bytes.length !== after.size)
    )
      throw new ManagedFileError('FILE_CHANGED', 'managed file changed during read');
    options.signal?.throwIfAborted();
    const inspected = await inspectFile(
      inspection.inspect,
      {
        prefix: bytes.slice(0, inspection.bytes),
        name: basename(path),
      },
      inspection.timeoutMs,
      options.signal,
    );
    source = {
      ref: inspectedRef(path, bytes.byteLength, inspected),
      bytes,
      ...(options.observe
        ? {
            observation: {
              dev: after.dev,
              ino: after.ino,
              size: after.size,
              nlink: after.nlink,
              mtimeMs: after.mtimeMs,
              ctimeMs: after.ctimeMs,
            },
          }
        : {}),
    };
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    try {
      await handle.close();
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
  }
  if (failed) throw failure;
  if (source === undefined) throw new Error('Read completed without a result');
  return source;
}
