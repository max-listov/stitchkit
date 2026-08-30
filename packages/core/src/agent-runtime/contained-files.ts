import {
  close as closeDescriptor,
  constants,
  existsSync,
  fchmod,
  fstat,
  read as readDescriptor,
  type Stats,
  write as writeDescriptor,
} from 'node:fs';
import { lstat, open, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ContainedFile {
  absolute: string;
  relative: string;
  content?: { text: string; bytes: number; mode: number };
}

export interface ContainedFileScan {
  files: readonly ContainedFile[];
  truncated: boolean;
  skippedDirectories: number;
  skippedSymlinks: number;
}

export interface ContainedFileHandle {
  readonly fd: number;
  close(): Promise<void>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  stat(): Promise<Stats>;
}

interface DarwinEntry {
  name: string;
  mode: number;
  size: number;
}

interface DarwinBinding {
  openDirectoryAt(directory: number, name: string): number;
  openFileAt(directory: number, name: string): number;
  createFileAt(directory: number, name: string, mode: number): number;
  statAt(directory: number, name: string): Omit<DarwinEntry, 'name'> | null;
  listAt(directory: number): readonly DarwinEntry[];
  renameAt(directory: number, source: string, target: string): void;
  unlinkAt(directory: number, name: string): void;
}

const FILE_TYPE_MASK = 0o170000;
const FILE_TYPE_DIRECTORY = 0o040000;
const FILE_TYPE_REGULAR = 0o100000;
const FILE_TYPE_SYMLINK = 0o120000;

function modeIs(mode: number, type: number): boolean {
  return (mode & FILE_TYPE_MASK) === type;
}

function hasFunctions(value: unknown, names: readonly string[]): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    names.every((name) => typeof Reflect.get(value, name) === 'function')
  );
}

let darwinBinding: DarwinBinding | undefined;

function loadDarwinBinding(): DarwinBinding {
  if (darwinBinding) return darwinBinding;
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const binary = `darwin-${process.arch}.node`;
  const candidates = [
    path.resolve(directory, '../native', binary),
    path.resolve(directory, '../../native', binary),
  ];
  const selected = candidates.find((candidate) => existsSync(candidate));
  if (!selected) {
    throw new Error(
      `Contained filesystem operations need the packaged Darwin ${process.arch} backend`,
    );
  }
  const loaded: unknown = createRequire(import.meta.url)(selected);
  const methods = [
    'openDirectoryAt',
    'openFileAt',
    'createFileAt',
    'statAt',
    'listAt',
    'renameAt',
    'unlinkAt',
  ];
  if (!hasFunctions(loaded, methods)) {
    throw new Error('The packaged Darwin contained-files backend has an invalid surface');
  }
  // Native Node-API is an untyped external boundary; every callable was checked above.
  darwinBinding = loaded as DarwinBinding;
  return darwinBinding;
}

class NumericFileHandle implements ContainedFileHandle {
  constructor(readonly fd: number) {}

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      closeDescriptor(this.fd, (error) => (error ? reject(error) : resolve()));
    });
  }

  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }> {
    return new Promise((resolve, reject) => {
      readDescriptor(this.fd, buffer, offset, length, position, (error, bytesRead) =>
        error ? reject(error) : resolve({ bytesRead }),
      );
    });
  }

  stat(): Promise<Stats> {
    return new Promise((resolve, reject) => {
      fstat(this.fd, (error, metadata) => (error ? reject(error) : resolve(metadata)));
    });
  }
}

function descriptorPath(handle: ContainedFileHandle): string {
  if (process.platform === 'linux') return `/proc/self/fd/${handle.fd}`;
  throw new Error('Descriptor paths are available only in the Linux contained-files backend');
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function openPinnedDirectory(absolute: string): Promise<ContainedFileHandle> {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw new Error('Contained filesystem operations support Linux and macOS only');
  }
  const expected = await realpath(absolute);
  const handle = await open(
    expected,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const [pathMetadata, handleMetadata] = await Promise.all([lstat(expected), handle.stat()]);
    if (!pathMetadata.isDirectory() || !sameIdentity(pathMetadata, handleMetadata)) {
      throw new Error('Contained directory identity changed while opening');
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function safeSegments(relative: string): string[] {
  if (path.isAbsolute(relative)) throw new Error('Contained paths must be relative');
  const segments = relative.split(/[\\/]/u);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error('Contained path has invalid segments');
  }
  return segments;
}

async function openDirectoryAt(
  directory: ContainedFileHandle,
  name: string,
): Promise<ContainedFileHandle> {
  if (process.platform === 'darwin') {
    return new NumericFileHandle(loadDarwinBinding().openDirectoryAt(directory.fd, name));
  }
  return open(
    path.join(descriptorPath(directory), name),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
}

async function openFileAt(
  directory: ContainedFileHandle,
  name: string,
): Promise<ContainedFileHandle> {
  if (process.platform === 'darwin') {
    return new NumericFileHandle(loadDarwinBinding().openFileAt(directory.fd, name));
  }
  return open(
    path.join(descriptorPath(directory), name),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
}

interface ContainedEntryMetadata {
  mode: number;
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

function entryMetadata(mode: number): ContainedEntryMetadata {
  return {
    mode,
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
    return metadata ? entryMetadata(metadata.mode) : null;
  }
  return lstat(path.join(descriptorPath(directory), name)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    },
  );
}

async function listAt(
  directory: ContainedFileHandle,
): Promise<readonly ContainedDirectoryEntry[]> {
  if (process.platform === 'darwin') {
    return loadDarwinBinding()
      .listAt(directory.fd)
      .map(({ name, mode }) => ({ name, ...entryMetadata(mode) }));
  }
  return readdir(descriptorPath(directory), { withFileTypes: true });
}

export interface ContainedParent {
  handle: ContainedFileHandle;
  basename: string;
}

/** Pin every ancestor as a directory descriptor before returning the final parent capability. */
export async function openContainedParent(
  root: string,
  relative: string,
): Promise<ContainedParent> {
  const segments = safeSegments(relative);
  const basename = segments.pop();
  if (!basename) throw new Error('Contained path is missing a basename');
  let current = await openPinnedDirectory(root);
  try {
    for (const segment of segments) {
      const next = await openDirectoryAt(current, segment);
      const metadata = await next.stat();
      if (!metadata.isDirectory()) {
        await next.close();
        throw new Error('Contained ancestor is not a directory');
      }
      await current.close();
      current = next;
    }
    return { handle: current, basename };
  } catch (error) {
    await current.close();
    throw error;
  }
}

/** Open a final regular-file candidate through pinned ancestors without following symlinks. */
export async function openContainedFile(
  root: string,
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

export async function assertContainedFileCurrent(
  root: string,
  relative: string,
  expected: ContainedFileHandle,
): Promise<void> {
  const current = await openContainedFile(root, relative);
  try {
    if (!sameIdentity(await expected.stat(), await current.stat())) {
      throw new Error('Contained file identity changed during authorization');
    }
  } finally {
    await current.close();
  }
}

export async function assertContainedParentCurrent(
  root: string,
  relative: string,
  expected: ContainedFileHandle,
): Promise<void> {
  const current = await openContainedParent(root, relative);
  try {
    if (!sameIdentity(await expected.stat(), await current.handle.stat())) {
      throw new Error('Contained parent identity changed during authorization');
    }
  } finally {
    await current.handle.close();
  }
}

async function writeDescriptorFully(descriptor: number, content: string): Promise<void> {
  const bytes = Buffer.from(content);
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

async function chmodDescriptor(descriptor: number, mode: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    fchmod(descriptor, mode & 0o7777, (error) => (error ? reject(error) : resolve()));
  });
}

async function createDarwinFile(
  parent: ContainedFileHandle,
  name: string,
  content: string,
  mode: number,
): Promise<void> {
  const binding = loadDarwinBinding();
  const descriptor = binding.createFileAt(parent.fd, name, mode & 0o7777);
  let failed: unknown;
  try {
    await writeDescriptorFully(descriptor, content);
    await chmodDescriptor(descriptor, mode);
  } catch (error) {
    failed = error;
  } finally {
    try {
      await new NumericFileHandle(descriptor).close();
    } catch (error) {
      failed ??= error;
    }
  }
  if (failed) {
    binding.unlinkAt(parent.fd, name);
    throw failed;
  }
}

/** Create or atomically replace one direct child through the pinned parent descriptor. */
export async function writeContainedFile(input: {
  parent: ContainedParent;
  content: string;
  replace: boolean;
  mode?: number;
}): Promise<void> {
  const mode = input.mode ?? 0o666;
  if (!input.replace) {
    if (process.platform === 'darwin') {
      await createDarwinFile(input.parent.handle, input.parent.basename, input.content, mode);
      return;
    }
    await writeFile(
      path.join(descriptorPath(input.parent.handle), input.parent.basename),
      input.content,
      { flag: 'wx', mode },
    );
    return;
  }

  const temporary = `.${input.parent.basename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  if (process.platform === 'darwin') {
    const binding = loadDarwinBinding();
    let created = false;
    try {
      await createDarwinFile(input.parent.handle, temporary, input.content, mode);
      created = true;
      binding.renameAt(input.parent.handle.fd, temporary, input.parent.basename);
    } catch (error) {
      if (created) binding.unlinkAt(input.parent.handle.fd, temporary);
      throw error;
    }
    return;
  }
  const directory = descriptorPath(input.parent.handle);
  const temporaryPath = path.join(directory, temporary);
  try {
    await writeFile(temporaryPath, input.content, { flag: 'wx', mode });
    await rename(temporaryPath, path.join(directory, input.parent.basename));
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
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

export async function readContainedUtf8Handle(
  handle: ContainedFileHandle,
  maxBytes: number,
): Promise<{ text: string; bytes: number; mode: number }> {
  const metadata = await handle.stat();
  if (!metadata.isFile()) throw new Error('Contained path is not a regular file');
  if (metadata.size > maxBytes) throw new Error('Contained file exceeds byte budget');
  const buffer = Buffer.alloc(metadata.size);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.byteLength - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== metadata.size) throw new Error('Contained file changed while being read');
  return {
    text: new TextDecoder('utf-8', { fatal: true }).decode(buffer),
    bytes: offset,
    mode: metadata.mode,
  };
}

/** Open the final path without following any mutable ancestor or replacement symlink. */
export async function readContainedUtf8File(
  root: string,
  relative: string,
  maxBytes: number,
): Promise<{ text: string; bytes: number; mode: number }> {
  const handle = await openContainedFile(root, relative);
  try {
    return await readContainedUtf8Handle(handle, maxBytes);
  } finally {
    await handle.close();
  }
}

/** One deterministic descriptor-anchored walker for harness resources and workspace search. */
export async function walkContainedFiles(input: {
  root: string;
  maxDepth: number;
  maxFiles: number;
  readMaxBytes?: number;
}): Promise<readonly ContainedFile[]> {
  const scan = await scanContainedFiles({ ...input, symlinks: 'refuse' });
  if (scan.truncated) throw new Error('Contained file traversal exceeded its bounds');
  return scan.files;
}

/** Bounded workspace scan whose recursion stays attached to opened directory identities. */
export async function scanContainedFiles(input: {
  root: string;
  maxDepth: number;
  maxFiles: number;
  symlinks: 'refuse' | 'skip';
  readMaxBytes?: number;
  skipUnreadable?: boolean;
  excludeDirectory?: (relative: string) => boolean;
}): Promise<ContainedFileScan> {
  const files: ContainedFile[] = [];
  let truncated = false;
  let skippedDirectories = 0;
  let skippedSymlinks = 0;
  const root = await openPinnedDirectory(input.root);
  const visit = async (
    directory: ContainedFileHandle,
    relativeDirectory: string,
    depth: number,
  ): Promise<void> => {
    if (truncated) return;
    if (depth > input.maxDepth) {
      truncated = true;
      return;
    }
    const entries = [...(await listAt(directory))];
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = relativeDirectory
        ? path.join(relativeDirectory, entry.name)
        : entry.name;
      if (entry.isSymbolicLink()) {
        if (input.symlinks === 'refuse') {
          throw new Error(`Contained file traversal refuses symlink: ${relative}`);
        }
        skippedSymlinks += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (input.excludeDirectory?.(relative)) {
          skippedDirectories += 1;
          continue;
        }
        let child: ContainedFileHandle;
        try {
          child = await openDirectoryAt(directory, entry.name);
        } catch (error) {
          if (input.symlinks === 'skip') {
            skippedSymlinks += 1;
            continue;
          }
          throw error;
        }
        try {
          await visit(child, relative, depth + 1);
        } finally {
          await child.close();
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= input.maxFiles) {
        truncated = true;
        return;
      }
      let content: ContainedFile['content'];
      if (input.readMaxBytes !== undefined) {
        try {
          const handle = await openFileAt(directory, entry.name);
          try {
            content = await readContainedUtf8Handle(handle, input.readMaxBytes);
          } finally {
            await handle.close();
          }
        } catch (error) {
          if (input.skipUnreadable) continue;
          throw error;
        }
      }
      files.push({ absolute: relative, relative, ...(content && { content }) });
    }
  };
  try {
    await visit(root, '', 0);
  } finally {
    await root.close();
  }
  return { files, truncated, skippedDirectories, skippedSymlinks };
}
