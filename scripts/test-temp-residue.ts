/**
 * A test run's own temporary directory, and what the run left in it.
 *
 * A test that creates a scratch directory and forgets it is as invisible to the suite as a process
 * left behind: the run is green and `/tmp` grows by a few directories every time, on a developer
 * machine and a CI runner alike. Measured on one machine: 514 `stitchkit-*` entries, 290 MB. The
 * cause is not always the test that names the prefix — a resource whose timer fires after the test
 * ended, or a write the test did not wait for, recreates a directory `afterEach` already removed.
 * Neither shows in a run of the file alone; both show in a shard, where the process lives on.
 *
 * So the leak gate (`--tmpdir`) gives the command a fresh, empty `TMPDIR`, lists whatever is in it
 * once the command has exited, removes it, and fails the run when the list is not empty. Every
 * `tmpdir()`, `mkdtemp` and child process of the run lands there, whatever prefix it chose.
 */
import { chmodSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Where the run's directory is made: `/tmp` (resolved: `/private/tmp` on macOS) when it exists,
 * else `tmpdir()`. Short on purpose — tests bind unix sockets under it, and a socket path has 104
 * bytes on macOS and 108 on Linux, while a macOS `tmpdir()` alone takes about fifty.
 */
export function runTempBase(): string {
  try {
    const base = realpathSync('/tmp');
    if (lstatSync(base).isDirectory()) return base;
  } catch {
    // No `/tmp` (Windows): the platform's own temporary directory.
  }
  return tmpdir();
}

/** The run directory's name before `mkdtemp`'s six characters: short, and no test's prefix. */
export const RUN_TEMP_PREFIX = 'sk-run-';

/**
 * A fresh directory for one run, as open as `/tmp` itself (`1777`): a test that drops privileges
 * to prove a permission refusal (`agent-coding-search-bounds`) must still reach its own scratch
 * directory under it, as it does under `/tmp`.
 */
export function createRunTempDir(base = runTempBase()): string {
  const directory = mkdtempSync(join(base, RUN_TEMP_PREFIX));
  chmodSync(directory, 0o1777);
  return directory;
}

export interface TempResidue {
  readonly name: string;
  readonly kind: 'directory' | 'file' | 'socket' | 'symlink' | 'other';
  /** Entries directly inside a directory; undefined for anything else. */
  readonly entries?: number;
}

/** What is left directly inside `directory`, sorted by name, each with its kind. */
export function tempResidue(directory: string): TempResidue[] {
  return readdirSync(directory)
    .sort()
    .map((name): TempResidue => {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        let entries = 0;
        try {
          entries = readdirSync(path).length;
        } catch {
          // A directory a test left unreadable (mode 0) is still residue; its count is unknown.
          return { name, kind: 'directory' };
        }
        return { name, kind: 'directory', entries };
      }
      if (stat.isSymbolicLink()) return { name, kind: 'symlink' };
      if (stat.isSocket()) return { name, kind: 'socket' };
      if (stat.isFile()) return { name, kind: 'file' };
      return { name, kind: 'other' };
    });
}

/** Up to this many entries are named; the rest are counted. */
const NAMED_RESIDUE = 40;

/** The report the gate prints for a non-empty residue. */
export function describeTempResidue(residue: readonly TempResidue[], command: string): string {
  const lines = residue.slice(0, NAMED_RESIDUE).map(({ name, kind, entries }) => {
    if (kind !== 'directory') return `  ${name} (${kind})`;
    if (entries === undefined) return `  ${name}/ (unreadable)`;
    return `  ${name}/ (${entries} entr${entries === 1 ? 'y' : 'ies'})`;
  });
  if (residue.length > NAMED_RESIDUE)
    lines.push(`  … and ${residue.length - NAMED_RESIDUE} more`);
  return `[test-gate] ${residue.length} temporary entr${residue.length === 1 ? 'y' : 'ies'} left in the run's TMPDIR by \`${command}\`; they were removed, and the run fails because a test left them behind:\n${lines.join('\n')}\n`;
}

/**
 * Remove the run's directory, whatever a test left in it: a directory it made unreadable or
 * unwritable is opened up first, so the removal cannot itself leave something behind.
 */
export function removeRunTempDir(directory: string): void {
  try {
    rmSync(directory, { recursive: true, force: true });
    return;
  } catch {
    // An entry with mode 0 under it: open everything up and remove again.
  }
  const open = (path: string): void => {
    const stat = lstatSync(path);
    if (!stat.isDirectory()) return;
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) open(join(path, name));
  };
  open(directory);
  rmSync(directory, { recursive: true, force: true });
}
