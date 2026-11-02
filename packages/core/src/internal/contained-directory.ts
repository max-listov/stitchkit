import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  type ContainedFileHandle,
  descriptorPath,
  NumericFileHandle,
} from './contained-handle';
import { loadDarwinBinding } from './darwin-binding';
import { errnoOf } from './errno';

// Stable OS flags absent from Node's portable constants; see open(2) and Apple's
// bsd/sys/fcntl.h. Both retain nofollow directory traversal.
const O_PATH_LINUX = 0x200000;
const O_SEARCH_DARWIN = 0x40000000;

function directoryFlags(searchOnly: boolean): number {
  const access = searchOnly
    ? process.platform === 'linux'
      ? O_PATH_LINUX
      : O_SEARCH_DARWIN
    : constants.O_RDONLY;
  return access | constants.O_DIRECTORY | constants.O_NOFOLLOW;
}

/** Open one child directory without following a symbolic link. */
export async function openDirectoryAt(
  directory: ContainedFileHandle,
  name: string,
  searchOnly = false,
): Promise<ContainedFileHandle> {
  if (process.platform === 'darwin') {
    return new NumericFileHandle(
      loadDarwinBinding().openDirectoryAt(directory.fd, name, searchOnly),
    );
  }
  return open(path.join(descriptorPath(directory), name), directoryFlags(searchOnly));
}

/** Move a walk to `next`; a failure to close the previous step does not leak the new one. */
export async function descend(
  current: ContainedFileHandle,
  next: ContainedFileHandle,
): Promise<ContainedFileHandle> {
  try {
    await current.close();
  } catch (error) {
    await next.close();
    throw error;
  }
  return next;
}

/** Create one directory through its pinned parent; false if an entry already exists. */
export async function createDirectoryAt(
  directory: ContainedFileHandle,
  name: string,
): Promise<boolean> {
  if (process.platform === 'darwin') {
    return loadDarwinBinding().createDirectoryAt(directory.fd, name, 0o777);
  }
  try {
    await mkdir(path.join(descriptorPath(directory), name));
    return true;
  } catch (error) {
    if (errnoOf(error) === 'EEXIST') return false;
    throw error;
  }
}

/**
 * Select the configured root once, then walk its canonical components through directory
 * descriptors. Initial root aliases are configuration; symlinks introduced after that
 * selection cannot redirect the walk. Missing descendants are created through the same
 * pinned parents. The returned capability remains the selected directory if it is renamed.
 */
export async function openPinnedDirectory(
  absolute: string,
  options: { create?: boolean; readable?: boolean } = {},
  io: { realpath(path: string): Promise<string> } = { realpath },
): Promise<ContainedFileHandle> {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw new Error('Contained filesystem operations support Linux and macOS only');
  }
  let prefix = path.resolve(absolute);
  const missing: string[] = [];
  let canonical: string;
  for (;;) {
    try {
      canonical = await io.realpath(prefix);
      break;
    } catch (error) {
      if (!options.create || errnoOf(error) !== 'ENOENT') throw error;
      const parent = path.dirname(prefix);
      if (parent === prefix) throw error;
      missing.unshift(path.basename(prefix));
      prefix = parent;
    }
  }
  const anchor = path.parse(canonical).root;
  let current: ContainedFileHandle = await open(anchor, directoryFlags(true));
  if (canonical === anchor && missing.length === 0 && options.readable !== false) {
    await current.close();
    return open(anchor, directoryFlags(false));
  }
  const existing = path.relative(anchor, canonical).split(path.sep).filter(Boolean);
  try {
    const segments = [...existing, ...missing];
    for (const [index, segment] of segments.entries()) {
      if (index >= existing.length) await createDirectoryAt(current, segment);
      const next = await openDirectoryAt(
        current,
        segment,
        index < segments.length - 1 || options.readable === false,
      );
      current = await descend(current, next);
    }
    return current;
  } catch (error) {
    await current.close();
    throw error;
  }
}
