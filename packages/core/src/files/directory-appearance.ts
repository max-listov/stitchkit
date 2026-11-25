import { statSync, watch } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { abortReason } from '../internal/abort-race';
import { assertTimerMs } from '../internal/deadline';
import { errnoOf } from '../internal/errno';

/** Default delay of the one deferred rescan after each watch start (milliseconds). */
const DEFAULT_DIRECTORY_SETTLE_MS = 250;

/** Cancellation, the deferred-rescan delay and process holding of `waitForDirectory`. */
export interface WaitForDirectoryOptions {
  /** Stops waiting: the promise rejects with the signal's reason and every watcher closes. */
  signal?: AbortSignal;
  /**
   * Delay of the single deferred rescan after a watch starts. A watcher can miss a
   * directory created right after it starts (Bun on macOS measurably does); the
   * deferred rescan catches it. It is also the delay before a watch refused with
   * `ENOENT`/`ENOTDIR` is tried again. There is no repeating timer while a watch holds.
   */
  settleMs?: number;
  /**
   * Whether the pending wait keeps the process alive; default `true`. With `false` the
   * watcher and the deferred rescan are unreferenced, so a process with nothing else to
   * do exits and the wait never settles.
   */
  keepAlive?: boolean;
}

interface DirectoryWatcher {
  close(): void;
  on(event: 'error', listener: (error: unknown) => void): unknown;
}

/** The filesystem the wait uses; tests replace it to count calls or drop events. */
export interface DirectoryAppearanceIo {
  isDirectory(path: string): boolean;
  watch(path: string, onEvent: () => void, options: { persistent: boolean }): DirectoryWatcher;
}

const ABSENT = new Set(['ENOENT', 'ENOTDIR']);

const nodeIo: DirectoryAppearanceIo = {
  isDirectory(path) {
    try {
      return statSync(path).isDirectory();
    } catch (error) {
      if (ABSENT.has(errnoOf(error) ?? '')) return false;
      throw error;
    }
  },
  watch(path, onEvent, { persistent }) {
    return watch(path, { persistent }, () => onEvent());
  },
};

function nearestDirectory(target: string, io: DirectoryAppearanceIo): string {
  let current = target;
  while (!io.isDirectory(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

/**
 * Resolve once `path` exists as a directory, without a polling timer. The
 * nearest existing ancestor is watched; when a component appears the watch moves
 * down to it, and when the watched directory goes away it moves back up. Each
 * watch start is followed by one immediate rescan and one deferred rescan after
 * `settleMs`, so a directory created between the check and the watch is still seen.
 * Each event re-arms the watch, so a directory removed and made again at once is
 * followed too. A symbolic link at the path counts once it resolves to a directory;
 * the appearance of its target elsewhere is not watched.
 */
export function waitForDirectory(
  path: string,
  options: WaitForDirectoryOptions = {},
): Promise<void> {
  return waitForDirectoryWith(nodeIo, path, options);
}

/** {@link waitForDirectory} over an injected filesystem. */
export function waitForDirectoryWith(
  io: DirectoryAppearanceIo,
  path: string,
  options: WaitForDirectoryOptions = {},
): Promise<void> {
  const target = resolve(path);
  const { signal, settleMs = DEFAULT_DIRECTORY_SETTLE_MS, keepAlive = true } = options;
  assertTimerMs('settleMs', settleMs);
  return new Promise<void>((resolveWait, rejectWait) => {
    if (signal?.aborted) {
      rejectWait(abortReason(signal));
      return;
    }
    let watcher: DirectoryWatcher | undefined;
    let watched: string | undefined;
    let settle: ReturnType<typeof setTimeout> | undefined;
    let done = false;

    const stopWatching = (): void => {
      watcher?.close();
      watcher = undefined;
      watched = undefined;
      if (settle !== undefined) clearTimeout(settle);
      settle = undefined;
    };
    const finish = (error?: unknown, failed = false): void => {
      if (done) return;
      done = true;
      stopWatching();
      signal?.removeEventListener('abort', onAbort);
      if (failed) rejectWait(error);
      else resolveWait();
    };
    const onAbort = (): void =>
      finish(signal === undefined ? undefined : abortReason(signal), true);

    const rescan = (): void => {
      if (done) return;
      let present: string;
      try {
        present = nearestDirectory(target, io);
      } catch (error) {
        finish(error, true);
        return;
      }
      if (present === target) {
        finish();
        return;
      }
      if (present === watched) return;
      stopWatching();
      let current: DirectoryWatcher;
      try {
        // Every event re-arms the watch: a watcher follows an inode, and a directory
        // removed and made again at the same path is a new one it never reports on.
        current = io.watch(
          present,
          () => {
            if (done || watcher !== current) return;
            stopWatching();
            rescan();
          },
          { persistent: keepAlive },
        );
      } catch (error) {
        // The directory went away between the check and the watch, or keeps refusing to be
        // watched while it reads as present: look again after `settleMs`, never at once —
        // an immediate retry of a refusal that persists would hold the event loop forever.
        if (ABSENT.has(errnoOf(error) ?? '')) {
          settle = setTimeout(rescan, settleMs);
          if (!keepAlive) settle.unref();
          return;
        }
        finish(error, true);
        return;
      }
      if (done) {
        try {
          current.close();
        } catch {
          // Best-effort close if a synchronous callback already completed the wait.
        }
        return;
      }
      watcher = current;
      watched = present;
      // A watcher that fails because its directory disappeared gives way to the next ancestor;
      // a persistent watcher error on an existing directory fails instead of looping forever.
      current.on('error', (error: unknown) => {
        if (done || watcher !== current) return;
        stopWatching();
        if (!ABSENT.has(errnoOf(error) ?? '')) {
          let stillDirectory: boolean;
          try {
            stillDirectory = io.isDirectory(present);
          } catch (statError) {
            finish(statError, true);
            return;
          }
          if (stillDirectory) {
            finish(error, true);
            return;
          }
        }
        rescan();
      });
      settle = setTimeout(rescan, settleMs);
      if (!keepAlive) settle.unref();
      rescan();
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    rescan();
  });
}
