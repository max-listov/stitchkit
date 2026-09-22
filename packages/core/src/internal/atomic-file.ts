/**
 * Replace a file without ever leaving half of one behind.
 *
 * Write beside the target, then rename onto it: the rename is atomic within a
 * filesystem, so a reader sees the old bytes or the new ones and never a
 * partial write. The staging path has to be in the target's own directory for
 * that to hold — a rename across filesystems is a copy, and a copy is exactly
 * the window this avoids.
 */
import { chmodSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Write `bytes` to `target` atomically, with an explicit mode. */
export function writeFileAtomic(target: string, bytes: Uint8Array, mode: number): void {
  const staged = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}`);
  writeFileSync(staged, bytes, { mode });
  // `writeFileSync`'s mode is masked by the process umask; the explicit chmod
  // is what makes an executable executable on a machine with a strict umask.
  chmodSync(staged, mode);
  renameSync(staged, target);
}
