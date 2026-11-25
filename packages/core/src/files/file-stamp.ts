import { lstat, stat } from 'node:fs/promises';
import { errnoOf } from '../internal/errno';
import type { NanosecondFileStats } from '../internal/file-observation';
import { fileCacheIdentity } from './regular-file';

/**
 * How old a file's last change must be, at the moment its bytes are read, for its metadata
 * alone to stand for those bytes later (the rule git calls racy timestamps). A rewrite of
 * the same length inside one tick of a coarse filesystem clock leaves size, mtime and ctime
 * as they were; 3 s covers the 2-second mtime of FAT and a kernel coarse-clock tick.
 */
export const RACY_STAMP_NS = 3_000_000_000n;

/** A file's metadata identity, and whether it alone proves the bytes read with it unchanged. */
export interface FileStamp {
  readonly identity: string;
  /**
   * The bytes were read at least {@link RACY_STAMP_NS} after the file's last change: the
   * newer of ctime and an mtime that is not ahead of the read.
   */
  readonly settled: boolean;
}

/** What a stat of a polled path found. */
export type PathStat =
  | { kind: 'missing' }
  | { kind: 'file'; stamp: FileStamp }
  | { kind: 'other' };

/** The wall clock the kernel stamps files with, in nanoseconds since the epoch. */
export function clockNs(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}

/** The stamp of `info` for bytes whose read started at `readStartedNs`. */
export function stampOf(info: NanosecondFileStats, readStartedNs: bigint): FileStamp {
  // The newer of the two (`Math.max` takes no bigint), leaving out an mtime ahead of the read:
  // one set by hand or by a clock that runs fast (`touch -d`, `tar x`, `rsync -t`). A write
  // after this read stamps the present, which differs from that future mtime, and ctime
  // still covers a write in the tick of this read.
  let changedNs = info.ctimeNs;
  if (info.mtimeNs > changedNs && info.mtimeNs <= readStartedNs) changedNs = info.mtimeNs;
  return {
    identity: fileCacheIdentity(info),
    settled: readStartedNs - changedNs >= RACY_STAMP_NS,
  };
}

/** {@link PathStat} of the stat `read` returns; any failure but `ENOENT` is `other`. */
export function pathStatOf(read: () => NanosecondFileStats, readStartedNs: bigint): PathStat {
  try {
    const info = read();
    return info.isFile()
      ? { kind: 'file', stamp: stampOf(info, readStartedNs) }
      : { kind: 'other' };
  } catch (error) {
    return errnoOf(error) === 'ENOENT' ? { kind: 'missing' } : { kind: 'other' };
  }
}

/** {@link pathStatOf} with an asynchronous `stat` (`lstat` under `noFollow`). */
export async function pathStatOfAsync(
  path: string,
  noFollow: boolean,
  readStartedNs: bigint,
): Promise<PathStat> {
  let info: NanosecondFileStats;
  try {
    info = noFollow ? await lstat(path, { bigint: true }) : await stat(path, { bigint: true });
  } catch (error) {
    return errnoOf(error) === 'ENOENT' ? { kind: 'missing' } : { kind: 'other' };
  }
  return pathStatOf(() => info, readStartedNs);
}
