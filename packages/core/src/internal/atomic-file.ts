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

import { closeSync, fchmodSync, fsyncSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  AtomicFilePublicationError,
  type AtomicPublishOptions,
  assertDirectoryDurability,
  publishAtomicFile,
  publishAtomicFileSync,
  syncDirectory,
} from './atomic-publication';
import { stagingPath } from './atomic-staging';
import { readBoundedFile, readBoundedFileSync } from './bounded-file-read';
import { closeAfter, closeAfterSync } from './close-after';
import { errnoOf } from './errno';

/** Options of {@link writeFileAtomic} and {@link writeFileAtomicSync}. */
export interface WriteFileAtomicOptions {
  /**
   * Permission bits of the written file, applied on the open descriptor before
   * the file becomes visible — not masked by the process umask. Defaults to
   * `0o600`: a file readable by other users of the machine is a decision the
   * caller states, never one a default makes for them.
   */
  mode?: number;
  /** Replace by default; false atomically refuses any existing file or link. */
  replace?: boolean;
  /**
   * Only valid with `replace: false` (throws `TypeError` otherwise). When `true`
   * and `target` already exists, succeed without replacing it if the existing
   * regular file (not a symlink, FIFO, or directory) already has identical bytes
   * and matching permission bits (`mode`, on POSIX).
   */
  idempotent?: boolean;
  /**
   * `'file'` (the default) fsyncs the bytes before publication; `'directory'`
   * also fsyncs the parent after it; `'none'` does neither.
   */
  durability?: 'none' | 'file' | 'directory';
}

const DEFAULT_MODE = 0o600;

function bytesOf(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? new TextEncoder().encode(data) : data;
}

function assertWriteOptions(options: WriteFileAtomicOptions): void {
  if (options.idempotent === true && options.replace !== false) {
    throw new TypeError('writeFileAtomic option "idempotent: true" requires "replace: false"');
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function modeMatches(actualMode: number | undefined, expectedMode: number): boolean {
  if (process.platform === 'win32') return true;
  return actualMode !== undefined && (actualMode & 0o7777) === (expectedMode & 0o7777);
}

function syncDirectorySync(dir: string): void {
  assertDirectoryDurability();
  const descriptor = openSync(dir, 'r');
  closeAfterSync(
    () => closeSync(descriptor),
    () => fsyncSync(descriptor),
  );
}

/** The staged file as a writer sees it; a `FileHandle` satisfies it. */
export interface StagedFile {
  write(bytes: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }>;
  chmod(mode: number): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** Write every byte of `bytes`; a short write continues and a write of zero bytes is an error. */
export async function writeAllBytes(file: StagedFile, bytes: Uint8Array): Promise<void> {
  for (let offset = 0; offset < bytes.byteLength; ) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.byteLength - offset);
    if (bytesWritten === 0) throw new Error('zero-byte atomic-file write');
    offset += bytesWritten;
  }
}

/**
 * Write `data` to `target` atomically: a reader sees the old contents or the
 * new ones, never part of either, and the new file has `mode` from its first
 * visible moment. A failure before publication leaves the target untouched. Directory-sync or
 * staging-link cleanup failure after publication throws AtomicFilePublicationError
 * with published=true; do not blindly repeat an external action.
 *
 * The bytes are staged in the target's directory under a name {@link isAtomicStagingName}
 * recognises (`.stitchkit-<24 hex>.tmp`, a stable public contract). A process killed before
 * publication leaves that file behind and no later write removes it: recognising and sweeping
 * abandoned staging ({@link sweepAtomicStaging}) is the caller's responsibility.
 */
export async function writeFileAtomic(
  target: string,
  data: Uint8Array | string,
  options: WriteFileAtomicOptions = {},
): Promise<void> {
  return writeAtomicFileData(target, data, options);
}

interface AtomicFileWriteIO {
  open(path: string, flags: 'wx', mode: number): Promise<StagedFile>;
  unlink(path: string): Promise<void>;
  publish(staged: string, target: string, options: AtomicPublishOptions): Promise<void>;
  readExisting?(
    target: string,
    maxBytes: number,
  ): Promise<{ bytes: Uint8Array; mode: number | undefined }>;
  syncDir?(dir: string): Promise<void>;
}

/** How the staged bytes of one atomic write are produced and vetted. */
export interface AtomicFileStage<T> {
  /** Fills the staged file; a throw discards the staging, and the result is what the write returns once published. */
  fill(file: StagedFile): Promise<T>;
  /** Exact expected bytes used when `idempotent: true` verifies an `EEXIST` target. */
  expectedBytes?: Uint8Array;
  /** Receives a failure to remove the staging file after a failed write. */
  onCleanupError?(error: unknown): void;
}

function isMissing(error: unknown): boolean {
  return errnoOf(error) === 'ENOENT';
}

async function publishMaybeIdempotent(
  staged: string,
  target: string,
  mode: number,
  options: WriteFileAtomicOptions,
  expectedBytes: Uint8Array | undefined,
  io: AtomicFileWriteIO,
): Promise<void> {
  const publishOptions: AtomicPublishOptions = {
    replace: options.replace ?? true,
    durability: options.durability ?? 'file',
  };
  try {
    await io.publish(staged, target, publishOptions);
    return;
  } catch (error) {
    if (
      options.idempotent !== true ||
      errnoOf(error) !== 'EEXIST' ||
      expectedBytes === undefined
    ) {
      throw error;
    }
    const readExisting =
      io.readExisting ??
      ((path: string, maxBytes: number) =>
        readBoundedFile(path, maxBytes, { rejectSymlinks: true }));
    let existing: { bytes: Uint8Array; mode: number | undefined };
    try {
      existing = await readExisting(target, expectedBytes.byteLength);
    } catch (readError) {
      if (isMissing(readError)) {
        // Target disappeared between EEXIST and inspection while `staged` is still on disk: 1 bounded retry.
        await io.publish(staged, target, publishOptions);
        return;
      }
      throw error;
    }
    if (!modeMatches(existing.mode, mode) || !bytesEqual(existing.bytes, expectedBytes)) {
      throw error;
    }
    try {
      await io.unlink(staged);
    } catch (cleanup) {
      if (!isMissing(cleanup)) throw new AtomicFilePublicationError('cleanup', cleanup);
    }
    if (publishOptions.durability === 'directory') {
      try {
        const syncDir = io.syncDir ?? syncDirectory;
        await syncDir(dirname(target));
      } catch (syncError) {
        throw new AtomicFilePublicationError('directory-sync', syncError);
      }
    }
  }
}

/**
 * The one staging sequence behind every asynchronous atomic write: exclusive
 * create, fill, chmod, fsync, publication, and removal of the
 * staging file on any failure. Also the internal syscall seam for
 * publication-order and precommit fault controls.
 */
export async function writeAtomicFileStaged<T>(
  target: string,
  stage: AtomicFileStage<T>,
  options: WriteFileAtomicOptions,
  io: AtomicFileWriteIO = { open, unlink, publish: publishAtomicFile },
): Promise<T> {
  assertWriteOptions(options);
  const mode = options.mode ?? DEFAULT_MODE;
  const staged = stagingPath(target);
  // `wx` — create, fail if the path exists at all. The descriptor is then the
  // file this call made, so the chmod and the write cannot be redirected.
  const file = await io.open(staged, 'wx', mode);
  try {
    const value = await closeAfter(file, async () => {
      const filled = await stage.fill(file);
      await file.chmod(mode);
      if (options.durability !== 'none') await file.sync();
      return filled;
    });
    await publishMaybeIdempotent(staged, target, mode, options, stage.expectedBytes, io);
    return value;
  } catch (error) {
    await io.unlink(staged).catch((cleanup: unknown) => {
      if (!isMissing(cleanup)) stage.onCleanupError?.(cleanup);
    });
    throw error;
  }
}

/** {@link writeAtomicFileStaged} for bytes already in memory. */
export async function writeAtomicFileData(
  target: string,
  data: Uint8Array | string,
  options: WriteFileAtomicOptions,
  io?: AtomicFileWriteIO,
): Promise<void> {
  const bytes = bytesOf(data);
  await writeAtomicFileStaged(
    target,
    { fill: (file) => writeAllBytes(file, bytes), expectedBytes: bytes },
    options,
    io,
  );
}

/** The staged file of the synchronous form. */
interface StagedFileSync {
  write(bytes: Uint8Array, offset: number, length: number): number;
  chmod(mode: number): void;
  sync(): void;
  close(): void;
}

interface AtomicFileWriteSyncIO {
  open(path: string, flags: 'wx', mode: number): StagedFileSync;
  unlink(path: string): void;
  publish(staged: string, target: string, options: AtomicPublishOptions): void;
  readExisting?(target: string, maxBytes: number): { bytes: Uint8Array; mode: number };
  syncDir?(dir: string): void;
}

const nativeSync: AtomicFileWriteSyncIO = {
  open(path, flags, mode) {
    const descriptor = openSync(path, flags, mode);
    return {
      write: (bytes, offset, length) => writeSync(descriptor, bytes, offset, length),
      chmod: (bits) => fchmodSync(descriptor, bits),
      sync: () => fsyncSync(descriptor),
      close: () => closeSync(descriptor),
    };
  },
  unlink: unlinkSync,
  publish: publishAtomicFileSync,
};

function publishMaybeIdempotentSync(
  staged: string,
  target: string,
  mode: number,
  options: WriteFileAtomicOptions,
  expectedBytes: Uint8Array,
  io: AtomicFileWriteSyncIO,
): void {
  const publishOptions: AtomicPublishOptions = {
    replace: options.replace ?? true,
    durability: options.durability ?? 'file',
  };
  try {
    io.publish(staged, target, publishOptions);
    return;
  } catch (error) {
    if (options.idempotent !== true || errnoOf(error) !== 'EEXIST') {
      throw error;
    }
    const readExisting =
      io.readExisting ??
      ((path: string, maxBytes: number) =>
        readBoundedFileSync(path, maxBytes, { rejectSymlinks: true }));
    let existing: { bytes: Uint8Array; mode: number };
    try {
      existing = readExisting(target, expectedBytes.byteLength);
    } catch (readError) {
      if (isMissing(readError)) {
        io.publish(staged, target, publishOptions);
        return;
      }
      throw error;
    }
    if (!modeMatches(existing.mode, mode) || !bytesEqual(existing.bytes, expectedBytes)) {
      throw error;
    }
    try {
      io.unlink(staged);
    } catch (cleanup) {
      if (!isMissing(cleanup)) throw new AtomicFilePublicationError('cleanup', cleanup);
    }
    if (publishOptions.durability === 'directory') {
      try {
        const syncDir = io.syncDir ?? syncDirectorySync;
        syncDir(dirname(target));
      } catch (syncError) {
        throw new AtomicFilePublicationError('directory-sync', syncError);
      }
    }
  }
}

/**
 * The synchronous form of {@link writeFileAtomic}, with the same guarantees in
 * the same order, and the same internal syscall seam.
 */
export function writeAtomicFileDataSync(
  target: string,
  data: Uint8Array | string,
  options: WriteFileAtomicOptions,
  io: AtomicFileWriteSyncIO = nativeSync,
): void {
  assertWriteOptions(options);
  const mode = options.mode ?? DEFAULT_MODE;
  const bytes = bytesOf(data);
  const staged = stagingPath(target);
  const file = io.open(staged, 'wx', mode);
  try {
    closeAfterSync(
      () => file.close(),
      () => {
        // `write` may write fewer bytes than asked; a single call would
        // silently truncate a large file and still rename it into place.
        for (let offset = 0; offset < bytes.byteLength; ) {
          const written = file.write(bytes, offset, bytes.byteLength - offset);
          if (written === 0) throw new Error('zero-byte atomic-file write');
          offset += written;
        }
        // The mode passed to `open` is masked by the process umask; the explicit
        // chmod on the open descriptor is what makes an executable executable on
        // a machine with a strict umask, and it cannot follow a link.
        file.chmod(mode);
        if (options.durability !== 'none') file.sync();
      },
    );
    publishMaybeIdempotentSync(staged, target, mode, options, bytes, io);
  } catch (error) {
    try {
      io.unlink(staged);
    } catch {
      // Already gone, or never renamed away — the original error is the report.
    }
    throw error;
  }
}

/** The synchronous form of {@link writeFileAtomic}, with the same guarantees in the same order. */
export function writeFileAtomicSync(
  target: string,
  data: Uint8Array | string,
  options: WriteFileAtomicOptions = {},
): void {
  writeAtomicFileDataSync(target, data, options);
}
