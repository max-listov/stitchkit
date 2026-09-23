/**
 * Replace a file without ever leaving half of one behind, and without handing
 * a writable directory to whoever guessed the staging name.
 *
 * Write beside the target, then rename onto it: the rename is atomic within a
 * filesystem, so a reader sees the old bytes or the new ones and never a
 * partial write. The staging path has to be in the target's own directory for
 * that to hold — a rename across filesystems is a copy, and a copy is exactly
 * the window this avoids.
 *
 * The staging name is random and the file is created exclusively. A name built
 * from pid and clock is guessable, and `writeFileSync` follows a symlink: an
 * attacker who can write to the directory plants `.app.1234.1700000000000` →
 * `/etc/something`, and the update writes its bytes through the link, chmods
 * the target 0o755 and then renames the link itself into place, so every later
 * write goes there too. `wx` refuses to open anything that already exists,
 * link or file, which closes it.
 *
 * Two forms with one order of guarantees. The asynchronous one exists because a
 * synchronous `rename` on a loaded machine was measured holding a consumer's
 * main thread for ~15 s — every timer and request of a daemon stood still.
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** Options of {@link writeFileAtomic} and {@link writeFileAtomicSync}. */
export interface WriteFileAtomicOptions {
  /**
   * Permission bits of the written file, applied on the open descriptor before
   * the file becomes visible — not masked by the process umask. Defaults to
   * `0o600`: a file readable by other users of the machine is a decision the
   * caller states, never one a default makes for them.
   */
  mode?: number;
}

const DEFAULT_MODE = 0o600;

function stagingPath(target: string): string {
  return join(dirname(target), `.${basename(target)}.${randomBytes(12).toString('hex')}.tmp`);
}

function bytesOf(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? new TextEncoder().encode(data) : data;
}

/**
 * Write `data` to `target` atomically: a reader sees the old contents or the
 * new ones, never part of either, and the new file has `mode` from its first
 * visible moment. A failed write leaves the target untouched and no staging
 * file behind.
 */
export async function writeFileAtomic(
  target: string,
  data: Uint8Array | string,
  options: WriteFileAtomicOptions = {},
): Promise<void> {
  const mode = options.mode ?? DEFAULT_MODE;
  const staged = stagingPath(target);
  // `wx` — create, fail if the path exists at all. The descriptor is then the
  // file this call made, so the chmod and the write cannot be redirected.
  const handle = await open(staged, 'wx', mode);
  try {
    try {
      await handle.writeFile(bytesOf(data));
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(staged, target);
  } catch (error) {
    await unlink(staged).catch(() => undefined);
    throw error;
  }
}

/** The synchronous form of {@link writeFileAtomic}, with the same guarantees in the same order. */
export function writeFileAtomicSync(
  target: string,
  data: Uint8Array | string,
  options: WriteFileAtomicOptions = {},
): void {
  const mode = options.mode ?? DEFAULT_MODE;
  const bytes = bytesOf(data);
  const staged = stagingPath(target);
  const handle = openSync(staged, 'wx', mode);
  try {
    try {
      // `writeSync` may write fewer bytes than asked; a single call would
      // silently truncate a large file and still rename it into place.
      for (let offset = 0; offset < bytes.byteLength; ) {
        offset += writeSync(handle, bytes, offset, bytes.byteLength - offset);
      }
      // The mode passed to `open` is masked by the process umask; the explicit
      // fchmod on the open descriptor is what makes an executable executable on
      // a machine with a strict umask, and it cannot follow a link.
      fchmodSync(handle, mode);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(staged, target);
  } catch (error) {
    try {
      unlinkSync(staged);
    } catch {
      // Already gone, or never renamed away — the original error is the report.
    }
    throw error;
  }
}
