import { constants, type Stats } from 'node:fs';
import { lstat, open, opendir, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  createDirectoryAt,
  descend,
  openDirectoryAt,
  openPinnedDirectory,
} from './contained-directory';
import {
  type ContainedFileHandle,
  descriptorPath,
  FILE_TYPE_DIRECTORY,
  FILE_TYPE_REGULAR,
  FILE_TYPE_SYMLINK,
  modeIs,
  NumericFileHandle,
} from './contained-handle';
import { loadDarwinBinding } from './darwin-binding';
import { errnoOf } from './errno';

export interface ContainedFile {
  absolute: string;
  relative: string;
  content?: { text: string; bytes: number; mode: number };
}

export type ContainedEntryKind = 'file' | 'directory' | 'symlink' | 'other';

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** One entry name a directory-relative call may receive: never a walk and never truncated by NUL. */
export function isSafeEntryName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !name.includes('\0');
}

function safeSegments(relative: string): string[] {
  if (path.isAbsolute(relative)) throw new Error('Contained paths must be relative');
  const segments = relative.split(/[\\/]/u);
  if (!segments.every(isSafeEntryName)) {
    throw new Error('Contained path has invalid segments');
  }
  return segments;
}

export async function openFileAt(
  directory: ContainedFileHandle,
  name: string,
): Promise<ContainedFileHandle> {
  if (process.platform === 'darwin') {
    return new NumericFileHandle(loadDarwinBinding().openFileAt(directory.fd, name));
  }
  return open(
    path.join(descriptorPath(directory), name),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
}

interface ContainedEntryMetadata {
  mode: number;
  /** Byte length for a regular file; absent where the platform did not report one. */
  size?: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

interface ContainedDirectoryEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

function entryMetadata(mode: number, size?: number): ContainedEntryMetadata {
  return {
    mode,
    ...(size !== undefined && { size }),
    isDirectory: () => modeIs(mode, FILE_TYPE_DIRECTORY),
    isFile: () => modeIs(mode, FILE_TYPE_REGULAR),
    isSymbolicLink: () => modeIs(mode, FILE_TYPE_SYMLINK),
  };
}

async function statAt(
  directory: ContainedFileHandle,
  name: string,
): Promise<ContainedEntryMetadata | null> {
  if (process.platform === 'darwin') {
    const metadata = loadDarwinBinding().statAt(directory.fd, name);
    return metadata ? entryMetadata(metadata.mode, metadata.size) : null;
  }
  return lstat(path.join(descriptorPath(directory), name)).catch((error: unknown) => {
    if (errnoOf(error) === 'ENOENT') return null;
    throw error;
  });
}

export async function listAt(
  directory: ContainedFileHandle,
  maxEntries?: number,
  progress?: { check(): void; entry(): void },
): Promise<readonly ContainedDirectoryEntry[]> {
  progress?.check();
  if (process.platform === 'darwin') {
    return loadDarwinBinding()
      .listAt(
        directory.fd,
        maxEntries,
        progress
          ? (entry) => {
              if (entry) progress.entry();
              progress.check();
            }
          : undefined,
      )
      .map(({ name, mode }) => ({ name, ...entryMetadata(mode) }));
  }
  if (maxEntries !== undefined) {
    const stream = await opendir(descriptorPath(directory), { bufferSize: 1 });
    const entries: ContainedDirectoryEntry[] = [];
    try {
      while (entries.length < maxEntries) {
        progress?.check();
        const entry = await stream.read();
        if (entry) progress?.entry();
        progress?.check();
        if (!entry) break;
        entries.push(entry);
      }
      return entries;
    } finally {
      await stream.close();
    }
  }
  return readdir(descriptorPath(directory), { withFileTypes: true });
}

/** One descendant directory opened from the request's selected root. */
export async function openContainedDirectory(
  root: string | ContainedFileHandle,
  relative: string,
  beforeOpen?: () => void,
): Promise<ContainedFileHandle> {
  let current = await openPinnedDirectory(root);
  try {
    if (relative !== '.')
      for (const segment of safeSegments(relative)) {
        beforeOpen?.();
        current = await descend(current, await openDirectoryAt(current, segment));
      }
    return current;
  } catch (error) {
    await current.close();
    throw error;
  }
}

export interface ContainedParent {
  handle: ContainedFileHandle;
  basename: string;
}

/**
 * Which ancestors of `relative` do not exist yet, outermost first.
 *
 * Read-only on purpose: the caller authorizes the mutation before any of it
 * happens, and cannot do that without knowing what would be created.
 */
export async function missingContainedDirectories(
  root: string | ContainedFileHandle,
  relative: string,
): Promise<string[]> {
  const segments = safeSegments(relative);
  segments.pop();
  const missing: string[] = [];
  let current = await openPinnedDirectory(root);
  try {
    let walked: string[] = [];
    for (const segment of segments) {
      walked = [...walked, segment];
      if (missing.length > 0) {
        // Once one ancestor is missing every deeper one is too, and there is
        // nothing left to open.
        missing.push(walked.join(path.sep));
        continue;
      }
      const next = await openDirectoryAt(current, segment).catch((error: unknown) => {
        if (errnoOf(error) === 'ENOENT') return null;
        throw error;
      });
      if (!next) {
        missing.push(walked.join(path.sep));
        continue;
      }
      current = await descend(current, next);
    }
    return missing;
  } finally {
    await current.close();
  }
}

/** The spellings a case- or normalization-insensitive volume opens as the same entry. */
function alternateSpellings(name: string): string[] {
  const swapped = [...name]
    .map((letter) =>
      letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase(),
    )
    .join('');
  return [...new Set([swapped, name.normalize('NFC'), name.normalize('NFD')])].filter(
    (spelling) => spelling !== name,
  );
}

/**
 * The first segment of `relative` that opens an entry stored under another spelling.
 *
 * A policy compares strings, and a volume that folds case or normalization opens
 * `CREDENTIALS` for a rule written against `credentials`. An entry that answers to
 * another spelling is the only cost here: a listing runs only then, and it decides,
 * because two distinct entries may exist on a volume that does not fold. A missing
 * segment is not misspelled; the caller reports it.
 */
export async function misspelledContainedSegment(
  root: string | ContainedFileHandle,
  relative: string,
  progress?: {
    check(): void;
    directory(): void;
    entry(): void;
    remainingEntries(): number | undefined;
    wait<T>(operation: () => Promise<T>, disposeLate?: (value: T) => void): Promise<T>;
  },
): Promise<string | undefined> {
  const segments = safeSegments(relative);
  const wait = <T>(operation: () => Promise<T>, disposeLate?: (value: T) => void) =>
    progress ? progress.wait(operation, disposeLate) : operation();
  const dispose = (handle: ContainedFileHandle) => {
    void handle.close().catch(() => undefined);
  };
  let current = await wait(() => openPinnedDirectory(root), dispose);
  try {
    for (const [index, segment] of segments.entries()) {
      progress?.check();
      const exists = async (name: string): Promise<boolean> =>
        (await wait(() => statAt(current, name).catch(() => null))) !== null;
      let folded = false;
      for (const spelling of alternateSpellings(segment)) {
        folded ||= await exists(spelling);
      }
      if (folded && (await exists(segment))) {
        const maximum = progress?.remainingEntries();
        const entries = await wait(() => listAt(current, maximum, progress));
        // Native stat may drop a concurrently deleted name after counting it.
        // Only observed-entry accounting can prove the spelling scan complete.
        progress?.remainingEntries();
        const stored = entries.some(({ name }) => name === segment);
        if (!stored) return segment;
      }
      if (index === segments.length - 1) return undefined;
      progress?.directory();
      const next = await wait(
        () =>
          openDirectoryAt(current, segment).catch((error: unknown) => {
            if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(errnoOf(error) ?? '')) return null;
            throw error;
          }),
        (handle) => {
          if (handle) dispose(handle);
        },
      );
      if (!next) return undefined;
      current = await descend(current, next);
    }
    return undefined;
  } finally {
    await current.close();
  }
}

/** A directory vanished after the host approved a different creation plan. */
export class UnapprovedContainedDirectoryError extends Error {
  constructor(readonly relative: string) {
    super(`Contained directory creation was not authorized: ${relative}`);
    this.name = 'UnapprovedContainedDirectoryError';
  }
}

export async function openContainedParent(
  root: string | ContainedFileHandle,
  relative: string,
  options: { createDirectories?: readonly string[] } = {},
): Promise<ContainedParent> {
  const segments = safeSegments(relative);
  const basename = segments.pop();
  if (!basename) throw new Error('Contained path is missing a basename');
  let current = await openPinnedDirectory(root);
  try {
    const approved = new Set(options.createDirectories);
    const walked: string[] = [];
    for (const segment of segments) {
      walked.push(segment);
      const next = await openDirectoryAt(current, segment).catch(async (error: unknown) => {
        if (options.createDirectories === undefined || errnoOf(error) !== 'ENOENT')
          throw error;
        const directory = walked.join(path.sep);
        if (!approved.has(directory)) throw new UnapprovedContainedDirectoryError(directory);
        await createDirectoryAt(current, segment);
        // The nofollow open establishes containment even when another writer wins mkdir.
        return openDirectoryAt(current, segment);
      });
      current = await descend(current, next);
    }
    return { handle: current, basename };
  } catch (error) {
    await current.close();
    throw error;
  }
}

/** Open a final regular-file candidate through pinned ancestors without following symlinks. */
export async function openContainedFile(
  root: string | ContainedFileHandle,
  relative: string,
): Promise<ContainedFileHandle> {
  const parent = await openContainedParent(root, relative);
  try {
    const handle = await openFileAt(parent.handle, parent.basename);
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      await handle.close();
      throw new Error('Contained path is not a regular file');
    }
    return handle;
  } finally {
    await parent.handle.close();
  }
}

/** What was checked is no longer what the path names; the caller can look again. */
export class ContainedPathChangedError extends Error {
  constructor(readonly relative: string) {
    super(`Contained path changed during authorization: ${relative}`);
    this.name = 'ContainedPathChangedError';
  }
}

/** Reopening a path that vanished or stopped being a directory is the same stale answer. */
async function reopen<T>(relative: string, open: () => Promise<T>): Promise<T> {
  return open().catch((error: unknown) => {
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(errnoOf(error) ?? '')) {
      throw new ContainedPathChangedError(relative);
    }
    throw error;
  });
}

export async function assertContainedFileCurrent(
  root: string | ContainedFileHandle,
  relative: string,
  expected: ContainedFileHandle,
): Promise<void> {
  const current = await reopen(relative, () => openContainedFile(root, relative));
  try {
    if (!sameIdentity(await expected.stat(), await current.stat())) {
      throw new ContainedPathChangedError(relative);
    }
  } finally {
    await current.close();
  }
}

export async function assertContainedParentCurrent(
  root: string | ContainedFileHandle,
  relative: string,
  expected: ContainedFileHandle,
): Promise<void> {
  const current = await reopen(relative, () => openContainedParent(root, relative));
  try {
    if (!sameIdentity(await expected.stat(), await current.handle.stat())) {
      throw new ContainedPathChangedError(relative);
    }
  } finally {
    await current.handle.close();
  }
}

export async function containedEntryMetadata(
  parent: ContainedParent,
): Promise<ContainedEntryMetadata | null> {
  return statAt(parent.handle, parent.basename);
}

export async function openContainedParentFile(
  parent: ContainedParent,
): Promise<ContainedFileHandle> {
  const handle = await openFileAt(parent.handle, parent.basename);
  if (!(await handle.stat()).isFile()) {
    await handle.close();
    throw new Error('Contained path is not a regular file');
  }
  return handle;
}
