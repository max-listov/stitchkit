import { lstatSync, statSync } from 'node:fs';
import { lstat, stat } from 'node:fs/promises';
import type {
  FileObservation,
  FileReadStat,
  FileStatsView,
  NanosecondFileStats,
} from './file-observation';

/** Minimal stat of the current target path used to confirm a read still matches its name. */
export interface FilePathStat {
  dev: number | bigint;
  ino: number | bigint;
  isFile(): boolean;
}

/** Injectable path-stat hook for deterministic async snapshot tests. */
export interface BoundedFileSnapshotHooks {
  namedStat?: (path: string) => Promise<FilePathStat>;
}

/** Injectable path-stat hook for deterministic sync snapshot tests. */
export interface BoundedFileSnapshotSyncHooks {
  namedStatSync?: (path: string) => FilePathStat;
}

export function sameDeviceOrInode(a: number | bigint, b: number | bigint): boolean {
  return typeof a === 'bigint' || typeof b === 'bigint' ? BigInt(a) === BigInt(b) : a === b;
}

export function sameSize(statSize: number | bigint, byteLength: number): boolean {
  return typeof statSize === 'bigint'
    ? statSize === BigInt(byteLength)
    : statSize === byteLength;
}

export function isPathSwapErrno(
  code: string | undefined,
  rejectSymlinks: boolean | undefined,
): boolean {
  return (
    code === 'ENOENT' || code === 'ENOTDIR' || (rejectSymlinks === true && code === 'ELOOP')
  );
}

export function matchesNamedPath(
  after: { dev: number | bigint; ino: number | bigint },
  named: FilePathStat,
): boolean {
  return (
    named.isFile() &&
    sameDeviceOrInode(after.dev, named.dev) &&
    sameDeviceOrInode(after.ino, named.ino)
  );
}

export function defaultNamedStat(
  path: string,
  rejectSymlinks: boolean | undefined,
): Promise<FilePathStat> {
  return rejectSymlinks ? lstat(path, { bigint: true }) : stat(path, { bigint: true });
}

export function defaultNamedStatSync(
  path: string,
  rejectSymlinks: boolean | undefined,
): FilePathStat {
  return rejectSymlinks ? lstatSync(path, { bigint: true }) : statSync(path, { bigint: true });
}

export function isNanosecondStats(
  info: FileReadStat | NanosecondFileStats,
): info is NanosecondFileStats {
  return typeof info.ino === 'bigint' && 'mtimeNs' in info && typeof info.mtimeNs === 'bigint';
}

export const observationOf = (info: FileObservation): FileObservation => ({
  dev: info.dev,
  ino: info.ino,
  size: info.size,
  nlink: info.nlink,
  mtimeMs: info.mtimeMs,
  ctimeMs: info.ctimeMs,
});

/**
 * Match libuv/Node/Bun `Stats.mtimeMs` / `ctimeMs` bit-for-bit (`sec * 1000 + nsec / 1e6`):
 * `BigIntStats.mtimeMs` truncates sub-millisecond fractions and `Number(mtimeNs) / 1e6` loses
 * low bits above `Number.MAX_SAFE_INTEGER`.
 */
function nsToFloatMs(ns: bigint): number {
  return Number(ns / 1_000_000_000n) * 1000 + Number(ns % 1_000_000_000n) / 1e6;
}

export const bigObservation = (info: NanosecondFileStats): FileObservation => ({
  dev: Number(info.dev),
  ino: Number(info.ino),
  size: Number(info.size),
  nlink: Number(info.nlink),
  mtimeMs: nsToFloatMs(info.mtimeNs),
  ctimeMs: nsToFloatMs(info.ctimeNs),
});

export function toObservation(info: FileReadStat | NanosecondFileStats): FileObservation {
  return isNanosecondStats(info) ? bigObservation(info) : observationOf(info);
}

export function statsViewOf(info: NanosecondFileStats): FileStatsView {
  return {
    dev: Number(info.dev),
    ino: Number(info.ino),
    size: Number(info.size),
    nlink: Number(info.nlink),
    mtimeMs: nsToFloatMs(info.mtimeNs),
    ctimeMs: nsToFloatMs(info.ctimeNs),
    mode: Number(info.mode),
    uid: Number(info.uid),
    gid: Number(info.gid),
    isFile: () => info.isFile(),
    isDirectory: () => info.isDirectory?.() ?? false,
    isSymbolicLink: () => info.isSymbolicLink?.() ?? false,
  };
}

export function sameBigStat(
  before: NanosecondFileStats,
  after: NanosecondFileStats,
  length: number,
): boolean {
  return (
    after.isFile() &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs &&
    before.nlink === after.nlink &&
    before.mode === after.mode &&
    before.uid === after.uid &&
    before.gid === after.gid &&
    BigInt(length) === after.size
  );
}

export function sameReadStat(
  before: FileReadStat | NanosecondFileStats,
  after: FileReadStat | NanosecondFileStats,
  length: number,
): boolean {
  if (isNanosecondStats(before) && isNanosecondStats(after)) {
    return sameBigStat(before, after, length);
  }
  const b = toObservation(before);
  const a = toObservation(after);
  return (
    after.isFile() &&
    b.dev === a.dev &&
    b.ino === a.ino &&
    b.size === a.size &&
    b.mtimeMs === a.mtimeMs &&
    b.ctimeMs === a.ctimeMs &&
    b.nlink === a.nlink &&
    (before.mode === undefined ? undefined : Number(before.mode)) ===
      (after.mode === undefined ? undefined : Number(after.mode)) &&
    (before.uid === undefined ? undefined : Number(before.uid)) ===
      (after.uid === undefined ? undefined : Number(after.uid)) &&
    (before.gid === undefined ? undefined : Number(before.gid)) ===
      (after.gid === undefined ? undefined : Number(after.gid)) &&
    sameSize(after.size, length)
  );
}
