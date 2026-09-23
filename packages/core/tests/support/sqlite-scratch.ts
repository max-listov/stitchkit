import { accessSync, constants } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A scratch directory for a test's SQLite files, on memory-backed storage
 * where the machine has it.
 *
 * The agent store commits in SQLite's default rollback-journal mode, and one
 * approval-chronology case measured 200–228 `fsync` calls. On a developer
 * disk that is ~12 ms in total; on a shared CI runner each `fsync` can cost
 * milliseconds, and the heaviest case crossed the 5 s test budget there while
 * taking 0.3 s locally. What these tests prove — that a conversation survives
 * closing and reopening the database — is a property of what SQLite wrote,
 * not of when the disk acknowledged it, so `/dev/shm` proves the same thing
 * without charging for the flush.
 */
export async function sqliteScratchDir(prefix: string): Promise<string> {
  let base = tmpdir();
  try {
    accessSync('/dev/shm', constants.W_OK);
    base = '/dev/shm';
  } catch {
    // No memory-backed tmpfs (macOS, Windows): the ordinary temp dir.
  }
  return mkdtemp(join(base, prefix));
}
