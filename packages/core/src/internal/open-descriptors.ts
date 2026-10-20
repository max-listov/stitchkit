/**
 * Whether this process holds an open descriptor on a file — the evidence that tells a lock this
 * process image holds from one an earlier image of the same PID left behind.
 *
 * A process image replaced in place (`execve`, which is how `bun --watch` restarts) keeps its PID
 * and its kernel start time, so PID, boot and start identity all still match the owner record.
 * What does not survive the replacement is every descriptor opened close-on-exec, and Node and Bun
 * open every file that way. The descriptor table belongs to the process, not to a JavaScript
 * realm: a worker thread and a second copy of this module loaded into the same process see the
 * same table, so a hold taken by any of them is seen here. A token kept in module or realm state
 * would mistake each of them for a previous image and take a lock from a live holder.
 */
import { constants, fstatSync } from 'node:fs';
import { open, readdir } from 'node:fs/promises';

/** The calling process's descriptors: `/proc/self/fd` on Linux, the fdesc mount on macOS. */
const DESCRIPTOR_DIRECTORY = '/dev/fd';

/** The file a descriptor must refer to, as `stat` identifies it. */
export interface FileIdentity {
  readonly ino: number;
  readonly dev: number;
}

/**
 * `true` when another descriptor of this process refers to the file at `path` — still the file
 * `file` names — `false` when none does, and `null` when that cannot be told: the file is gone or
 * replaced, or the listing is not proven complete. Unknown never proves that a holder is gone.
 *
 * The listing proves itself: the probe opens the file, and the answer counts only when the
 * listing contains that fresh descriptor. A platform that lists a fixed few descriptors (a BSD
 * `/dev/fd` without fdescfs lists 0–2) answers `null`, not a false "nobody holds it".
 */
export async function holdsOpenDescriptor(
  path: string,
  file: FileIdentity,
  /** @internal A fixture listing; the real one is always this process's own. */
  descriptorDirectory = DESCRIPTOR_DIRECTORY,
): Promise<boolean | null> {
  const probe = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => null);
  if (!probe) return null;
  try {
    const opened = await probe.stat();
    if (!opened.isFile() || opened.ino !== file.ino || opened.dev !== file.dev) return null;
    let names: string[];
    try {
      names = await readdir(descriptorDirectory);
    } catch {
      return null;
    }
    let listedProbe = false;
    for (const name of names) {
      const descriptor = Number(name);
      if (!Number.isInteger(descriptor) || descriptor < 0) continue;
      if (descriptor === probe.fd) {
        listedProbe = true;
        continue;
      }
      try {
        const info = fstatSync(descriptor);
        if (info.ino === file.ino && info.dev === file.dev) return true;
      } catch {
        // The listing's own directory descriptor, or one closed since the listing: neither is it.
      }
    }
    return listedProbe ? false : null;
  } finally {
    await probe.close();
  }
}
