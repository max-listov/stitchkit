/**
 * Writing a contained file through its pinned parent, never through a path an
 * attacker can swap underneath. A new name is created exclusively and written
 * directly: it needs no hard link, so it works on every filesystem, and a process
 * killed mid-write leaves a partial file at that name. A replacement is staged in
 * full, given its mode on the descriptor, then renamed into place: readers see the
 * old bytes or the new ones. Linux reaches entries through a descriptor path,
 * Darwin through the native binding; the sequence is one.
 */
import { constants, fchmod, open as openDescriptor, write as writeDescriptor } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import { stagingName } from './atomic-staging';
import type { ContainedParent } from './contained-files';
import {
  type ContainedFileHandle,
  descriptorPath,
  NumericFileHandle,
} from './contained-handle';
import { loadDarwinBinding } from './darwin-binding';

function entryPath(directory: ContainedFileHandle, name: string): string {
  return path.join(descriptorPath(directory), name);
}

async function openExclusive(
  directory: ContainedFileHandle,
  name: string,
  mode: number,
): Promise<number> {
  if (process.platform === 'darwin') {
    return loadDarwinBinding().createFileAt(directory.fd, name, mode);
  }
  return new Promise((resolve, reject) => {
    openDescriptor(
      entryPath(directory, name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
      (error, descriptor) => (error ? reject(error) : resolve(descriptor)),
    );
  });
}

async function renameEntry(
  directory: ContainedFileHandle,
  source: string,
  target: string,
): Promise<void> {
  if (process.platform === 'darwin') {
    loadDarwinBinding().renameAt(directory.fd, source, target);
    return;
  }
  await rename(entryPath(directory, source), entryPath(directory, target));
}

/**
 * Remove what this write created, by name: another writer that took the name after a
 * failed write loses it. The failure that led here stays the one reported.
 */
async function discardEntry(directory: ContainedFileHandle, name: string): Promise<void> {
  try {
    if (process.platform === 'darwin') loadDarwinBinding().unlinkAt(directory.fd, name);
    else await unlink(entryPath(directory, name));
  } catch {
    // Already gone, or occupied by something else: nothing of this write remains to report.
  }
}

async function writeDescriptorFully(
  descriptor: number,
  content: string | Uint8Array,
): Promise<void> {
  const bytes = typeof content === 'string' ? Buffer.from(content) : content;
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = await new Promise<number>((resolve, reject) => {
      writeDescriptor(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
        null,
        (error, bytesWritten) => (error ? reject(error) : resolve(bytesWritten)),
      );
    });
    if (written === 0) throw new Error('Contained file write made no progress');
    offset += written;
  }
}

/**
 * Give a new file exact permission bits. A file that already has them needs no call: a volume
 * whose creator does not own its files (FAT, CIFS, VirtualBox shares) refuses `fchmod` outright.
 */
async function applyMode(file: NumericFileHandle, mode: number): Promise<void> {
  if (((await file.stat()).mode & 0o777) === mode) return;
  await new Promise<void>((resolve, reject) => {
    fchmod(file.fd, mode, (error) => (error ? reject(error) : resolve()));
  });
}

/** Without an explicit mode the kernel's creation mode stands, umask and default ACLs included. */
async function createFile(
  directory: ContainedFileHandle,
  name: string,
  content: string | Uint8Array,
  mode: number | undefined,
): Promise<void> {
  const descriptor = await openExclusive(directory, name, mode ?? 0o666);
  const file = new NumericFileHandle(descriptor);
  let failed: unknown;
  try {
    await writeDescriptorFully(descriptor, content);
    if (mode !== undefined) await applyMode(file, mode);
  } catch (error) {
    failed = error;
  } finally {
    try {
      await file.close();
    } catch (error) {
      failed ??= error;
    }
  }
  if (failed) {
    await discardEntry(directory, name);
    throw failed;
  }
}

/**
 * Create or atomically replace one direct child through the pinned parent descriptor.
 * `mode` keeps permission bits only: new content must not inherit setuid, setgid or sticky.
 */
export async function writeContainedFile(input: {
  parent: ContainedParent;
  content: string | Uint8Array;
  replace: boolean;
  mode?: number;
}): Promise<void> {
  const { handle, basename } = input.parent;
  const mode = input.mode === undefined ? undefined : input.mode & 0o777;
  if (!input.replace) {
    await createFile(handle, basename, input.content, mode);
    return;
  }
  const temporary = stagingName();
  await createFile(handle, temporary, input.content, mode);
  try {
    await renameEntry(handle, temporary, basename);
  } catch (error) {
    await discardEntry(handle, temporary);
    throw error;
  }
}
