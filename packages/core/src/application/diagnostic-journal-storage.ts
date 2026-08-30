import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { isRecord } from '../internal/typed';
import type { DiagnosticJournalFailurePhase } from './diagnostic-journal-contract';

export interface DiagnosticJournalStorageSnapshot {
  readonly currentFileBytes: number;
  readonly retainedFiles: number;
  readonly rotations: number;
  readonly partialTails: number;
}

export interface DiagnosticJournalStorageAppendResult
  extends DiagnosticJournalStorageSnapshot {
  readonly rotated: boolean;
}

export interface DiagnosticJournalStorage {
  append(bytes: Uint8Array): Promise<DiagnosticJournalStorageAppendResult>;
  snapshot(): DiagnosticJournalStorageSnapshot;
  close(): Promise<void>;
}

export class DiagnosticJournalStorageError extends Error {
  constructor(
    public readonly phase: DiagnosticJournalFailurePhase,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'DiagnosticJournalStorageError';
  }
}

interface RotatingStorageConfig {
  readonly path: string;
  readonly maxFileBytes: number;
  readonly maxFiles: number;
  readonly mode: number;
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error('Diagnostic journal generations must be regular files');
    }
    await unlink(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function moveIfPresent(from: string, to: string): Promise<boolean> {
  try {
    const info = await lstat(from);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error('Diagnostic journal generations must be regular files');
    }
    await rename(from, to);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function generation(path: string, index: number): string {
  return `${path}.${index}`;
}

function generationIndex(name: string, prefix: string): number | undefined {
  if (!name.startsWith(prefix)) return undefined;
  const suffix = name.slice(prefix.length);
  if (!/^\d+$/.test(suffix)) return undefined;
  const value = Number(suffix);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** One exclusive local writer. The lock is deliberately not a cross-crash lease. */
export async function createRotatingDiagnosticJournalStorage(
  config: RotatingStorageConfig,
): Promise<DiagnosticJournalStorage> {
  if (!isAbsolute(config.path) || resolve(config.path) !== config.path) {
    throw new TypeError('Diagnostic journal path must be normalized and absolute');
  }
  const parent = await realpath(dirname(config.path));
  const journalPath = resolve(parent, basename(config.path));

  const lockPath = `${journalPath}.lock`;
  const lock = await open(lockPath, 'wx', config.mode);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let currentFileBytes = 0;
  let retainedFiles = 1;
  let rotations = 0;
  let partialTails = 0;
  let closed = false;

  const openCurrent = async (): Promise<void> => {
    handle = await open(
      journalPath,
      constants.O_APPEND | constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      config.mode,
    );
    const info = await handle.stat();
    if (!info.isFile()) {
      await handle.close();
      handle = undefined;
      throw new Error('Diagnostic journal path must be a regular file');
    }
    currentFileBytes = Number(info.size);
  };

  const rotate = async (): Promise<void> => {
    try {
      await handle?.close();
      handle = undefined;
      if (config.maxFiles === 1) {
        await removeIfPresent(journalPath);
      } else {
        await removeIfPresent(generation(journalPath, config.maxFiles - 1));
        for (let index = config.maxFiles - 2; index >= 1; index -= 1) {
          await moveIfPresent(
            generation(journalPath, index),
            generation(journalPath, index + 1),
          );
        }
        await moveIfPresent(journalPath, generation(journalPath, 1));
      }
      retainedFiles = Math.min(config.maxFiles, retainedFiles + 1);
      rotations += 1;
      await openCurrent();
    } catch (error) {
      throw new DiagnosticJournalStorageError(
        'rotation',
        'Diagnostic journal rotation failed',
        { cause: error },
      );
    }
  };

  try {
    const names = await readdir(parent);
    const prefix = `${basename(journalPath)}.`;
    let existingGenerations = 0;
    for (const name of names) {
      const index = generationIndex(name, prefix);
      if (index === undefined) continue;
      if (index >= config.maxFiles) {
        await removeIfPresent(resolve(parent, name));
      } else {
        const info = await lstat(resolve(parent, name));
        if (info.isSymbolicLink() || !info.isFile()) {
          throw new Error('Diagnostic journal generations must be regular files');
        }
        existingGenerations += 1;
      }
    }
    retainedFiles = Math.min(config.maxFiles, existingGenerations + 1);
    await openCurrent();
    if (currentFileBytes > 0) {
      const tail = new Uint8Array(1);
      const read = await handle?.read(tail, 0, 1, currentFileBytes - 1);
      if (read?.bytesRead === 1 && tail[0] !== 10) {
        partialTails += 1;
        await rotate();
      }
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await lock.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
    throw error;
  }

  const snapshot = (): DiagnosticJournalStorageSnapshot => ({
    currentFileBytes,
    retainedFiles,
    rotations,
    partialTails,
  });

  return {
    async append(bytes) {
      if (closed || !handle) {
        throw new DiagnosticJournalStorageError(
          'write',
          'Diagnostic journal storage is closed',
        );
      }
      let rotated = false;
      if (currentFileBytes > 0 && currentFileBytes + bytes.byteLength > config.maxFileBytes) {
        await rotate();
        rotated = true;
      }
      try {
        await handle.writeFile(bytes);
        currentFileBytes += bytes.byteLength;
        return { ...snapshot(), rotated };
      } catch (error) {
        throw new DiagnosticJournalStorageError('write', 'Diagnostic journal write failed', {
          cause: error,
        });
      }
    },
    snapshot,
    async close() {
      if (closed) return;
      closed = true;
      let failure: unknown;
      try {
        await handle?.close();
      } catch (error) {
        failure = error;
      }
      try {
        await lock.close();
        await unlink(lockPath);
      } catch (error) {
        failure ??= error;
      }
      if (failure !== undefined) {
        throw new DiagnosticJournalStorageError('close', 'Diagnostic journal close failed', {
          cause: failure,
        });
      }
    },
  };
}
