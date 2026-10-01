import { closeSync, fsyncSync, linkSync, openSync, renameSync, unlinkSync } from 'node:fs';
import { link, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

/** The new target is visible; failure is not evidence that publication did not occur. */
export class AtomicFilePublicationError extends Error {
  readonly published = true;
  constructor(
    public readonly phase: 'cleanup' | 'directory-sync' | 'directory-close',
    cause: unknown,
  ) {
    super(`File published but ${phase} failed`, { cause });
    this.name = 'AtomicFilePublicationError';
  }
}

/** Native publication syscalls; injectable only at this internal IO boundary for fault controls. */
export interface PublicationIO {
  rename(from: string, to: string): Promise<void>;
  link(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  open(path: string, flags: 'r'): Promise<{ sync(): Promise<void>; close(): Promise<void> }>;
}
const native: PublicationIO = { rename, link, unlink, open };

export async function publishAtomicFile(
  staged: string,
  target: string,
  replace: boolean,
  directorySync: boolean,
  io: PublicationIO = native,
): Promise<void> {
  if (directorySync && process.platform === 'win32')
    throw new Error('Directory durability is unsupported on Windows');
  // Admit the directory capability before changing the target. Filesystem-specific
  // fsync failures can still occur after publication and are reported as such.
  const directory = directorySync ? await io.open(dirname(target), 'r') : undefined;
  let failed = false;
  let failure: unknown;
  try {
    if (replace) await io.rename(staged, target);
    else {
      await io.link(staged, target);
      try {
        await io.unlink(staged);
      } catch (error) {
        throw new AtomicFilePublicationError('cleanup', error);
      }
    }
    try {
      await directory?.sync();
    } catch (error) {
      throw new AtomicFilePublicationError('directory-sync', error);
    }
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    try {
      await directory?.close();
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = new AtomicFilePublicationError('directory-close', error);
      }
    }
  }
  if (failed) throw failure;
}

export function publishAtomicFileSync(
  staged: string,
  target: string,
  replace: boolean,
  directorySync: boolean,
): void {
  if (directorySync && process.platform === 'win32')
    throw new Error('Directory durability is unsupported on Windows');
  const directory = directorySync ? openSync(dirname(target), 'r') : undefined;
  let failed = false;
  let failure: unknown;
  try {
    if (replace) renameSync(staged, target);
    else {
      linkSync(staged, target);
      try {
        unlinkSync(staged);
      } catch (error) {
        throw new AtomicFilePublicationError('cleanup', error);
      }
    }
    try {
      if (directory !== undefined) fsyncSync(directory);
    } catch (error) {
      throw new AtomicFilePublicationError('directory-sync', error);
    }
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    try {
      if (directory !== undefined) closeSync(directory);
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = new AtomicFilePublicationError('directory-close', error);
      }
    }
  }
  if (failed) throw failure;
}
