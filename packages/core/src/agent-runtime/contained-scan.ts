import path from 'node:path';
import {
  type ContainedEntryKind,
  type ContainedFile,
  type ContainedFileHandle,
  type ContainedFileScan,
  listAt,
  openDirectoryAt,
  openFileAt,
  openPinnedDirectory,
  readContainedUtf8Handle,
} from './contained-files';

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
  includeFile?: (relative: string) => boolean;
  authorizePath?: (
    relative: string,
    kind: 'file' | 'directory' | 'symlink' | 'other',
  ) => boolean | Promise<boolean>;
}): Promise<ContainedFileScan> {
  const files: ContainedFile[] = [];
  let truncated = false;
  let skippedDirectories = 0;
  let skippedSymlinks = 0;
  const denied: { relative: string; kind: ContainedEntryKind }[] = [];
  let deniedTruncated = false;
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
      const kind = entry.isDirectory()
        ? 'directory'
        : entry.isSymbolicLink()
          ? 'symlink'
          : entry.isFile()
            ? 'file'
            : 'other';
      if (kind === 'file' && input.includeFile && !input.includeFile(relative)) continue;
      if (input.authorizePath && !(await input.authorizePath(relative, kind))) {
        if (denied.length < input.maxFiles) denied.push({ relative, kind });
        else deniedTruncated = true;
        continue;
      }
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
  return { files, truncated, skippedDirectories, skippedSymlinks, denied, deniedTruncated };
}
