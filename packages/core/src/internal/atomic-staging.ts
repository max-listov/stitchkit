/**
 * The one name every staged file of an atomic write carries, and the means to
 * recognise and remove the ones a killed process left behind.
 *
 * A staging file lives in the target's own directory until it is renamed or
 * linked onto the target. A process killed between the exclusive create and
 * the publication (SIGKILL, OOM, power loss) leaves it there, and no later
 * write of this library touches it: its name is random, so nothing could tell
 * an abandoned one from a write in flight except its age. That judgement is the
 * caller's, so the caller is given the predicate and an age-bounded sweep.
 *
 * The name form is a public contract: `.stitchkit-` + 24 lowercase hex digits +
 * `.tmp`. The writer and the predicate are built from the constants below, so
 * they cannot disagree; changing the form is a breaking change of
 * `stitchkit/files`.
 */

import { randomBytes } from 'node:crypto';
import { lstat, readdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertPositiveSafeInteger } from './positive-integer';

const PREFIX = '.stitchkit-';
const SUFFIX = '.tmp';
const RANDOM_BYTES = 12;
const literal = (text: string): string => text.replaceAll('.', '\\.');
const NAME = new RegExp(`^${literal(PREFIX)}[0-9a-f]{${RANDOM_BYTES * 2}}${literal(SUFFIX)}$`);

/** A fresh staging file name; fixed length, so a long target name cannot push it past NAME_MAX. */
export function stagingName(): string {
  return `${PREFIX}${randomBytes(RANDOM_BYTES).toString('hex')}${SUFFIX}`;
}

/** A fresh staging path beside `target`: the rename onto it must not cross a filesystem. */
export function stagingPath(target: string): string {
  return join(dirname(target), stagingName());
}

/**
 * True when `name` (a directory entry, not a path) is the staging file of an atomic write
 * of this library. The form is a stable public contract; changing it is a breaking change.
 */
export function isAtomicStagingName(name: string): boolean {
  return NAME.test(name);
}

/** Options of {@link sweepAtomicStaging}. */
export interface SweepAtomicStagingOptions {
  /** The directory to sweep; its subdirectories are never entered. */
  directory: string;
  /**
   * Only a staging file whose last modification is older than this many milliseconds is
   * removed. Required and positive: it must exceed the longest write in flight, or the
   * sweep removes the staging of a write that is still running.
   */
  olderThanMs: number;
  /** Stops the sweep between entries; files already removed stay removed. */
  signal?: AbortSignal;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
  );
}

/**
 * Remove the abandoned staging files of atomic writes from one directory and return their
 * names. Only regular files matching {@link isAtomicStagingName} and older than `olderThanMs`
 * are removed; a symlink, a directory or any other entry is left alone, and nothing is
 * followed or recursed into. A `directory` that does not exist holds nothing to sweep and
 * yields `[]`; any other listing failure (a file in its place, a denied read) throws.
 */
export async function sweepAtomicStaging(
  options: SweepAtomicStagingOptions,
): Promise<string[]> {
  const { directory, olderThanMs, signal } = options;
  assertPositiveSafeInteger('olderThanMs', olderThanMs, RangeError);
  signal?.throwIfAborted();
  const cutoff = Date.now() - olderThanMs;
  const removed: string[] = [];
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isMissing(error)) return removed;
    throw error;
  }
  for (const name of names) {
    signal?.throwIfAborted();
    if (!isAtomicStagingName(name)) continue;
    const path = join(directory, name);
    try {
      // lstat, never stat: a link named like a staging file is not one and is not followed.
      const info = await lstat(path);
      if (!info.isFile() || info.mtimeMs > cutoff) continue;
      await unlink(path);
      removed.push(name);
    } catch (error) {
      // Published or swept by someone else between the listing and here.
      if (!isMissing(error)) throw error;
    }
  }
  return removed;
}
