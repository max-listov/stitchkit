import { constants } from 'node:fs';
import { type FileHandle, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

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

function descriptorPath(handle: FileHandle): string {
  if (process.platform === 'linux') return `/proc/self/fd/${handle.fd}`;
  if (process.platform === 'darwin' || process.platform === 'freebsd') {
    return `/dev/fd/${handle.fd}`;
  }
  throw new Error('Contained filesystem operations require descriptor paths on this platform');
}

async function openPinnedDirectory(absolute: string): Promise<FileHandle> {
  const expected = await realpath(absolute);
  const handle = await open(
    expected,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    if ((await realpath(descriptorPath(handle))) !== expected) {
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

export interface ContainedParent {
  handle: FileHandle;
  path: string;
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
      const next = await open(
        path.join(descriptorPath(current), segment),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const metadata = await next.stat();
      if (!metadata.isDirectory()) {
        await next.close();
        throw new Error('Contained ancestor is not a directory');
      }
      await current.close();
      current = next;
    }
    return { handle: current, path: descriptorPath(current), basename };
  } catch (error) {
    await current.close();
    throw error;
  }
}

/** Open a final regular-file candidate through pinned ancestors without following symlinks. */
export async function openContainedFile(root: string, relative: string): Promise<FileHandle> {
  const parent = await openContainedParent(root, relative);
  try {
    const handle = await open(
      path.join(parent.path, parent.basename),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
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

function sameIdentity(
  left: Awaited<ReturnType<FileHandle['stat']>>,
  right: Awaited<ReturnType<FileHandle['stat']>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export async function assertContainedFileCurrent(
  root: string,
  relative: string,
  expected: FileHandle,
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
  expected: FileHandle,
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

export async function readContainedUtf8Handle(
  handle: FileHandle,
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
    directory: FileHandle,
    relativeDirectory: string,
    depth: number,
  ): Promise<void> => {
    if (truncated) return;
    if (depth > input.maxDepth) {
      truncated = true;
      return;
    }
    const entries = await readdir(descriptorPath(directory), { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = relativeDirectory
        ? path.join(relativeDirectory, entry.name)
        : entry.name;
      const anchored = path.join(descriptorPath(directory), entry.name);
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
        let child: FileHandle;
        try {
          child = await open(
            anchored,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
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
          const handle = await open(anchored, constants.O_RDONLY | constants.O_NOFOLLOW);
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
