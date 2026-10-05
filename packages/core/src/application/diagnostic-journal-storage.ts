import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { isRecord } from '../internal/typed';
import type {
  DiagnosticJournalFailurePhase,
  DiagnosticJournalLockPolicy,
  DiagnosticJournalStartupRefusalPolicy,
  DiagnosticJournalStartupScan,
} from './diagnostic-journal-contract';
import {
  generation,
  listDiagnosticJournalGenerations,
  retainedDiagnosticJournalGenerations,
} from './diagnostic-journal-generations';
import { acquireDiagnosticJournalLock } from './diagnostic-journal-lock';
import {
  createStartupRefusalHandler,
  type DiagnosticJournalQuarantinedFile,
  listQuarantinedFiles,
} from './diagnostic-journal-quarantine';
import type { DiagnosticJournalRecoveryStatus } from './diagnostic-journal-read-contract';
import { inspectDiagnosticJournalRecovery } from './diagnostic-journal-recovery';

export interface DiagnosticJournalStorageSnapshot {
  readonly currentFileBytes: number;
  readonly retainedFiles: number;
  readonly rotations: number;
  readonly partialTails: number;
  readonly recovery?: DiagnosticJournalRecoveryStatus;
}

export interface DiagnosticJournalStorageAppendResult
  extends DiagnosticJournalStorageSnapshot {
  readonly rotated: boolean;
}

export interface DiagnosticJournalStorage {
  /** This storage took its lock by reclaiming one whose owner was provably gone. */
  readonly reclaimedStale: boolean;
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
  readonly lock: DiagnosticJournalLockPolicy;
  readonly scan: DiagnosticJournalStartupScan;
  readonly onStartupRefusal: DiagnosticJournalStartupRefusalPolicy;
  /** The process epoch; it names the files this open moves aside. */
  readonly epoch: string;
  readonly machineIdentity?: string;
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
  const { lock, reclaimedStale } = await acquireDiagnosticJournalLock(
    lockPath,
    config.mode,
    config.lock,
    config.machineIdentity,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let currentFileBytes = 0;
  let retainedFiles = 1;
  let rotations = 0;
  let partialTails = 0;
  let recovery: DiagnosticJournalRecoveryStatus | undefined;
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

  const refuse = createStartupRefusalHandler(config.onStartupRefusal, config.epoch);
  try {
    const prefix = `${basename(journalPath)}.`;
    const listing = await listDiagnosticJournalGenerations(
      parent,
      prefix,
      config.maxFiles,
      refuse,
    );
    const quarantined: DiagnosticJournalQuarantinedFile[] = [...listing.quarantined];
    retainedFiles = Math.min(config.maxFiles, listing.existing + 1);
    await openCurrent();
    if (currentFileBytes > 0) {
      const tail = new Uint8Array(1);
      const read = await handle?.read(tail, 0, 1, currentFileBytes - 1);
      if (read?.bytesRead === 1 && tail[0] !== 10) {
        partialTails += 1;
        if (config.maxFiles === 1) {
          // No slot to rotate the torn file into: it is refused, never truncated.
          const recovery =
            config.onStartupRefusal === 'fail'
              ? await inspectDiagnosticJournalRecovery({
                  paths: [journalPath],
                  maxLineBytes: config.maxFileBytes,
                  scan: config.scan,
                })
              : undefined;
          await handle?.close();
          handle = undefined;
          quarantined.push(
            await refuse({
              file: journalPath,
              reason: 'torn-without-retention-slot',
              ...(recovery && { recovery }),
            }),
          );
          await openCurrent();
        } else {
          await rotate();
        }
      }
    }
    // Refuse destructive single-file recovery before applying ordinary retention.
    for (const path of listing.expired) await removeIfPresent(path);
    const retained = await retainedDiagnosticJournalGenerations(
      parent,
      prefix,
      config.maxFiles,
    );
    const inspected = await inspectDiagnosticJournalRecovery({
      paths: [...retained, journalPath],
      maxLineBytes: config.maxFileBytes,
      scan: config.scan,
      onUnreadable: async (file, error) => {
        const active = file === journalPath;
        if (active) {
          await handle?.close();
          handle = undefined;
        }
        quarantined.push(
          await refuse({
            file,
            // The shared open refuses a link or a non-file with a `TypeError`.
            reason: error instanceof TypeError ? 'not-a-regular-file' : 'unreadable',
            cause: error,
          }),
        );
        if (active) await openCurrent();
        else retainedFiles -= 1;
      },
    });
    const listed = listQuarantinedFiles(quarantined, listing.quarantinedEarlier);
    if (inspected.anomalies > 0 || listed.quarantined) {
      recovery = { ...inspected, ...listed };
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await lock.release().catch(() => undefined);
    throw error;
  }

  const snapshot = (): DiagnosticJournalStorageSnapshot => ({
    currentFileBytes,
    retainedFiles,
    rotations,
    partialTails,
    ...(recovery && { recovery }),
  });

  return {
    reclaimedStale,
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
      await closeBoth(handle, lock);
    },
  };
}

/** Closes the file and releases the lock, both attempted; the first failure is the cause. */
async function closeBoth(
  handle: { close(): Promise<void> } | undefined,
  lock: { release(): Promise<void> },
): Promise<void> {
  let failure: unknown;
  try {
    await handle?.close();
  } catch (error) {
    failure = error;
  }
  try {
    await lock.release();
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) {
    throw new DiagnosticJournalStorageError('close', 'Diagnostic journal close failed', {
      cause: failure,
    });
  }
}
