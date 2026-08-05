import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isWithinDir } from './within-dir';

/**
 * Write a downloaded body to disk, with the containment check both download
 * paths need.
 *
 * Shared by the CLI's `--output-dir` and the `mountDownload` native tool. It
 * deliberately takes an **already-resolved** target rather than building one:
 * the two callers derive the filename differently (an untrusted `file.name` vs a
 * name derived from the URL) and, more importantly, report the path back to the
 * user — so composing it here would silently change one of those outputs from
 * relative to absolute.
 *
 * The containment re-check is cheap and belongs on this side: both callers reduce
 * the name to a basename first, but that is an invariant of *their* code, and
 * this is where the write actually happens.
 */
export async function writeDownload(
  root: string,
  target: string,
  data: Uint8Array,
): Promise<void> {
  if (!isWithinDir(root, target)) {
    throw new Error('download name escapes the output dir');
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, data);
}
