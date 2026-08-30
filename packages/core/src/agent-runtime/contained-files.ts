import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

export interface ContainedFile {
  absolute: string;
  relative: string;
}

export interface ContainedFileScan {
  files: readonly ContainedFile[];
  truncated: boolean;
  skippedDirectories: number;
  skippedSymlinks: number;
}

/** Open the final path without following a replacement symlink and allocate only within budget. */
export async function readContainedUtf8File(
  absolute: string,
  maxBytes: number,
): Promise<{ text: string; bytes: number; mode: number }> {
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
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
  } finally {
    await handle.close();
  }
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** One deterministic, symlink-refusing walker for harness resources and workspace search. */
export async function walkContainedFiles(input: {
  root: string;
  maxDepth: number;
  maxFiles: number;
}): Promise<readonly ContainedFile[]> {
  const scan = await scanContainedFiles({ ...input, symlinks: 'refuse' });
  if (scan.truncated) throw new Error('Contained file traversal exceeded its bounds');
  return scan.files;
}

/** Bounded workspace scan that can omit known trees and symlinks without following either. */
export async function scanContainedFiles(input: {
  root: string;
  maxDepth: number;
  maxFiles: number;
  symlinks: 'refuse' | 'skip';
  excludeDirectory?: (relative: string) => boolean;
}): Promise<ContainedFileScan> {
  const root = await realpath(input.root);
  const files: ContainedFile[] = [];
  let truncated = false;
  let skippedDirectories = 0;
  let skippedSymlinks = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (truncated) return;
    if (depth > input.maxDepth) {
      truncated = true;
      return;
    }
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) {
        if (input.symlinks === 'refuse') {
          throw new Error(
            `Contained file traversal refuses symlink: ${path.relative(root, absolute)}`,
          );
        }
        skippedSymlinks += 1;
        continue;
      }
      if (metadata.isDirectory()) {
        const relative = path.relative(root, absolute);
        if (input.excludeDirectory?.(relative)) {
          skippedDirectories += 1;
          continue;
        }
        await visit(absolute, depth + 1);
        continue;
      }
      if (!metadata.isFile()) continue;
      const resolved = await realpath(absolute);
      if (!inside(root, resolved)) throw new Error('Contained file traversal escaped root');
      if (files.length >= input.maxFiles) {
        truncated = true;
        return;
      }
      files.push({ absolute: resolved, relative: path.relative(root, resolved) });
    }
  };
  await visit(root, 0);
  return { files, truncated, skippedDirectories, skippedSymlinks };
}
