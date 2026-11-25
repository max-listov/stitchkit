/**
 * File metadata (device, inode, size, link count, times) captured at one moment, used to tell
 * whether a file changed between reads. It lives apart from the descriptor readers so the public
 * declarations that name it do not pull in a file-handle type.
 */
export interface FileObservation {
  dev: number;
  ino: number;
  size: number;
  nlink: number;
  mtimeMs: number;
  ctimeMs: number;
}

/**
 * What a bounded reader asks of an open file. `fs.promises.FileHandle` satisfies it, and naming
 * this instead keeps `node:fs/promises` out of every public declaration that takes an opener.
 */
export interface FileReadStat extends FileObservation {
  isFile(): boolean;
  mode?: number;
  uid?: number;
  gid?: number;
}

export interface FileReadDescriptor<S extends FileReadStat = FileReadStat> {
  stat(): Promise<S>;
  read(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

/** A file's metadata as a caller inspects it; `fs.Stats` satisfies it. */
export interface FileStatsView extends FileObservation {
  mode: number;
  uid: number;
  gid: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** Metadata an identity is computed from; `fs.Stats` and `fs.BigIntStats` both satisfy it. */
export interface FileIdentityStats {
  dev: number | bigint;
  ino: number | bigint;
  size: number | bigint;
  mtimeMs: number | bigint;
  ctimeMs: number | bigint;
  mtimeNs?: bigint;
  ctimeNs?: bigint;
}

/**
 * A nanosecond stat (`fs.BigIntStats` satisfies it) as a structural type, so a declaration that
 * names it never imports `node:fs` — a consumer without Node's types still resolves it.
 */
export interface NanosecondFileStats extends FileIdentityStats {
  mtimeNs: bigint;
  ctimeNs: bigint;
  mode: bigint;
  uid: bigint;
  gid: bigint;
  nlink: bigint;
  isFile(): boolean;
}
