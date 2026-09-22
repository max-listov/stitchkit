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
 */

import { randomBytes } from 'node:crypto';
import { closeSync, fchmodSync, fsyncSync, openSync, renameSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Write `bytes` to `target` atomically, with an explicit mode. */
export function writeFileAtomic(target: string, bytes: Uint8Array, mode: number): void {
  const staged = join(
    dirname(target),
    `.${basename(target)}.${randomBytes(12).toString('hex')}.tmp`,
  );
  // `wx` — create, fail if the path exists at all. The descriptor is then the
  // file this call made, so the chmod and the write cannot be redirected.
  const handle = openSync(staged, 'wx', mode);
  try {
    writeSync(handle, bytes);
    // `writeFileSync`'s mode is masked by the process umask; the explicit
    // fchmod on the open descriptor is what makes an executable executable on a
    // machine with a strict umask, and it cannot follow a link.
    fchmodSync(handle, mode);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(staged, target);
}
