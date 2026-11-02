import path from 'node:path';
import { containedEntryMetadata, isSafeEntryName } from './contained-files';
import type { ContainedFileHandle } from './contained-handle';
import { writeContainedFile } from './contained-write';

/**
 * Publish a CLI download as one direct child of the batch's pinned output root.
 * Atomic replacement replaces links themselves, never the inode they point to.
 * The caller owns the root descriptor and closes it after every file has settled.
 */
export async function writeDownload(
  root: ContainedFileHandle,
  name: string,
  data: Uint8Array,
): Promise<void> {
  if (!isSafeEntryName(name) || path.basename(name) !== name) {
    throw new Error('download name escapes the output dir');
  }
  const parent = { handle: root, basename: name };
  const metadata = await containedEntryMetadata(parent);
  await writeContainedFile({
    parent,
    content: data,
    replace: true,
    ...(metadata?.isFile() && { mode: metadata.mode }),
  });
}
