import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForDirectory } from '../src/entrypoints/files';
import {
  type DirectoryAppearanceIo,
  waitForDirectoryWith,
} from '../src/files/directory-appearance';
import { reapAfterEachTest, trackProcess } from './support/process-reaper';

reapAfterEachTest();

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stitchkit-directory-appearance-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function within<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([promise, sleep(ms).then(() => 'timeout' as const)]);
}

/** Real filesystem, with counters and an optional switch that drops every watch event. */
function countingIo(options: { dropEvents?: boolean; onWatch?: (path: string) => void } = {}) {
  const counts = { checks: 0, watches: 0, closes: 0, open: 0 };
  const io: DirectoryAppearanceIo = {
    isDirectory(path) {
      counts.checks += 1;
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    },
    hasEntry(path) {
      counts.checks += 1;
      try {
        lstatSync(path);
        return true;
      } catch {
        return false;
      }
    },
    watch(path, onEvent) {
      counts.watches += 1;
      counts.open += 1;
      options.onWatch?.(path);
      const watcher = watch(path, () => {
        if (!options.dropEvents) onEvent();
      });
      return {
        close() {
          counts.closes += 1;
          counts.open -= 1;
          watcher.close();
        },
        on(event, listener) {
          watcher.on(event, listener);
          return this;
        },
      };
    },
  };
  return { io, counts };
}

describe('waitForDirectory', () => {
  test('resolves at once for an existing directory, without a watcher', async () => {
    const { io, counts } = countingIo();
    await waitForDirectoryWith(io, root);
    expect(counts.watches).toBe(0);
  });

  test('follows a nested path into existence component by component', async () => {
    const target = join(root, 'a', 'b', 'c');
    // A deferred rescan this late cannot be what finds them: the watch events do.
    const waiting = waitForDirectory(target, { settleMs: 60_000 });
    await sleep(30);
    mkdirSync(join(root, 'a'));
    await sleep(30);
    mkdirSync(join(root, 'a', 'b'));
    await sleep(30);
    mkdirSync(target);
    expect(await within(waiting, 2_000)).toBeUndefined();
  });

  test('a file at the path is not the directory: the wait goes on until a directory replaces it', async () => {
    const target = join(root, 'conf.d');
    writeFileSync(target, 'not a directory');
    const waiting = waitForDirectory(target, { settleMs: 20 });
    expect(await within(waiting, 150)).toBe('timeout');
    rmSync(target);
    mkdirSync(target);
    expect(await within(waiting, 2_000)).toBeUndefined();
  });

  test('stays idle while nothing happens: no repeating timer re-checks the path', async () => {
    const { io, counts } = countingIo();
    const controller = new AbortController();
    const waiting = waitForDirectoryWith(io, join(root, 'missing', 'conf.d'), {
      signal: controller.signal,
      settleMs: 20,
    });
    await sleep(100);
    const settled = counts.checks;
    await sleep(400);
    expect(counts.checks).toBe(settled);
    controller.abort(new Error('stop'));
    await expect(waiting).rejects.toThrow('stop');
  });

  test('the deferred rescan finds a directory whose creation event the watcher missed, after settleMs', async () => {
    const target = join(root, 'conf.d');
    const prompt = waitForDirectoryWith(countingIo({ dropEvents: true }).io, target, {
      settleMs: 80,
    });
    const controller = new AbortController();
    const late = waitForDirectoryWith(countingIo({ dropEvents: true }).io, target, {
      settleMs: 60_000,
      signal: controller.signal,
    });
    await sleep(20);
    mkdirSync(target);
    expect(await within(prompt, 400)).toBeUndefined();
    expect(await within(late, 200)).toBe('timeout');
    controller.abort(new Error('done'));
    await expect(late).rejects.toThrow('done');
  });

  test('the immediate rescan finds a directory made between the check and the watch start', async () => {
    const target = join(root, 'conf.d');
    const { io } = countingIo({
      dropEvents: true,
      onWatch: () => mkdirSync(target, { recursive: true }),
    });
    const waiting = waitForDirectoryWith(io, target, { settleMs: 60_000 });
    expect(await within(waiting, 300)).toBeUndefined();
  });

  test('a watched directory removed and made again at once is still followed', async () => {
    const parent = join(root, 'parent');
    mkdirSync(parent);
    const target = join(parent, 'conf.d');
    const waiting = waitForDirectory(target, { settleMs: 60_000 });
    await sleep(30);
    rmSync(parent, { recursive: true });
    mkdirSync(parent);
    await sleep(30);
    mkdirSync(target);
    expect(await within(waiting, 2_000)).toBeUndefined();
  });

  test('abort rejects with the reason and closes every watcher', async () => {
    const { io, counts } = countingIo();
    const controller = new AbortController();
    const waiting = waitForDirectoryWith(io, join(root, 'x', 'y'), {
      signal: controller.signal,
    });
    await sleep(20);
    expect(counts.open).toBe(1);
    const reason = new Error('shutting down');
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    expect(counts.open).toBe(0);

    const already = new AbortController();
    already.abort(reason);
    await expect(
      waitForDirectoryWith(io, join(root, 'z'), { signal: already.signal }),
    ).rejects.toBe(reason);
  });

  test('when the watched directory is removed, the watch moves up and still sees the target', async () => {
    const parent = join(root, 'parent');
    mkdirSync(parent);
    const target = join(parent, 'conf.d');
    const waiting = waitForDirectory(target, { settleMs: 20 });
    await sleep(50);
    rmSync(parent, { recursive: true });
    await sleep(50);
    mkdirSync(target, { recursive: true });
    expect(await within(waiting, 2_000)).toBeUndefined();
  });

  test('fails on persistent non-absent watcher error when ancestor still exists', async () => {
    const target = join(root, 'perm-denied', 'child');
    const io = {
      isDirectory: (path: string) => path === root,
      watch: () => ({
        close: () => undefined,
        on: (_event: 'error', listener: (error: unknown) => void) => {
          queueMicrotask(() => {
            listener(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
          });
        },
      }),
    };
    await expect(waitForDirectoryWith(io, target)).rejects.toThrow('EACCES');
  });

  test('a directory that exists but cannot be watched (ENOENT) is retried after settleMs, never in a loop that starves timers', async () => {
    const target = join(root, 'racing', 'child');
    let watches = 0;
    const io: DirectoryAppearanceIo = {
      isDirectory: (path) => path === root,
      watch: () => {
        watches += 1;
        // A ceiling so the unfixed loop ends instead of hanging the runner.
        if (watches > 10_000) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('stop waiting')), 60);
    await expect(
      waitForDirectoryWith(io, target, { settleMs: 10, signal: controller.signal }),
    ).rejects.toThrow('stop waiting');
    expect(watches).toBeGreaterThan(1);
    expect(watches).toBeLessThan(20);
  });

  test('rejects cleanly without unhandled throw when io.isDirectory throws inside a real EventEmitter error handler', async () => {
    const target = join(root, 'perm-denied', 'child');
    const emitter = new EventEmitter();
    const statError = Object.assign(new Error('stat EACCES'), { code: 'EACCES' });
    const watchError = Object.assign(new Error('watcher EIO'), { code: 'EIO' });
    let failStat = false;
    let closed = false;
    const controller = new AbortController();

    const io: DirectoryAppearanceIo = {
      isDirectory(path) {
        if (failStat) throw statError;
        return path === root;
      },
      watch() {
        return {
          close() {
            closed = true;
          },
          on(event, listener) {
            return emitter.on(event, listener);
          },
        };
      },
    };

    const waiting = waitForDirectoryWith(io, target, {
      signal: controller.signal,
      settleMs: 60_000,
    });
    // Prevent unhandled rejection if the assertion below fails before awaiting `waiting`.
    waiting.catch(() => undefined);

    try {
      failStat = true;
      expect(() => emitter.emit('error', watchError)).not.toThrow();
      await expect(waiting).rejects.toBe(statError);
      expect(closed).toBe(true);
    } finally {
      controller.abort(new Error('cleanup'));
    }
  });
});

describe('waitForDirectory keepAlive', () => {
  const entrypoint = join(import.meta.dir, '..', 'src', 'entrypoints', 'files.ts');

  /** Exit code of a child that only arms a wait which never resolves, or `alive` after `ms`. */
  async function childExit(
    keepAlive: boolean | undefined,
    ms: number,
  ): Promise<number | 'alive'> {
    const script = join(root, 'arm.ts');
    const never = join(root, 'never', 'appears');
    const options =
      keepAlive === undefined
        ? '{ settleMs: 60_000 }'
        : `{ settleMs: 60_000, keepAlive: ${keepAlive} }`;
    writeFileSync(
      script,
      `import { waitForDirectory } from ${JSON.stringify(entrypoint)};\n` +
        `void waitForDirectory(${JSON.stringify(never)}, ${options}).catch(() => undefined);\n`,
    );
    const child = Bun.spawn([process.execPath, script], { stdout: 'ignore', stderr: 'pipe' });
    trackProcess(child.pid);
    const exited = await within(child.exited, ms);
    if (exited === 'timeout') {
      child.kill('SIGKILL');
      await child.exited;
      return 'alive';
    }
    return exited;
  }

  test('keepAlive: false leaves the process free to exit; the default holds it', async () => {
    expect(await childExit(false, 5_000)).toBe(0);
    expect(await childExit(undefined, 1_500)).toBe('alive');
    expect(await childExit(true, 1_500)).toBe('alive');
  });
});

describe('waitForDirectory match: entry', () => {
  test('wakes on regular file, broken symlink, cyclic symlink, directory, and trailing slash', async () => {
    // 1. Regular file appears
    const fileTarget = join(root, 'conf.d');
    const waitFile = waitForDirectory(fileTarget, { match: 'entry', settleMs: 20 });
    await sleep(30);
    writeFileSync(fileTarget, 'not a dir');
    expect(await within(waitFile, 2_000)).toBeUndefined();

    // 2. Broken symlink appears
    const brokenTarget = join(root, 'broken.d');
    const waitBroken = waitForDirectory(brokenTarget, { match: 'entry', settleMs: 20 });
    await sleep(30);
    symlinkSync(join(root, 'does-not-exist'), brokenTarget);
    expect(await within(waitBroken, 2_000)).toBeUndefined();

    // 3. Cyclic symlink (c -> c) appears
    const cyclicTarget = join(root, 'cyclic.d');
    const waitCyclic = waitForDirectory(cyclicTarget, { match: 'entry', settleMs: 20 });
    await sleep(30);
    symlinkSync(cyclicTarget, cyclicTarget);
    expect(await within(waitCyclic, 2_000)).toBeUndefined();

    // 4. Trailing slash resolves the normalized entry name
    const slashTarget = join(root, 'slash.d');
    const waitSlash = waitForDirectory(`${slashTarget}/`, { match: 'entry', settleMs: 20 });
    await sleep(30);
    writeFileSync(slashTarget, 'file');
    expect(await within(waitSlash, 2_000)).toBeUndefined();

    // 5. Real directory also wakes match: entry
    const dirTarget = join(root, 'real.d');
    const waitDir = waitForDirectory(dirTarget, { match: 'entry', settleMs: 20 });
    await sleep(30);
    mkdirSync(dirTarget);
    expect(await within(waitDir, 2_000)).toBeUndefined();
  });

  test('intermediate file or broken symlink does not wake match: entry; parent deletion and abort clean up', async () => {
    const intermediate = join(root, 'mid');
    const target = join(intermediate, 'conf.d');
    const waitNested = waitForDirectory(target, { match: 'entry', settleMs: 20 });
    await sleep(30);
    writeFileSync(intermediate, 'blocks path');
    expect(await within(waitNested, 150)).toBe('timeout');
    rmSync(intermediate);
    symlinkSync(join(root, 'nowhere'), intermediate);
    expect(await within(waitNested, 150)).toBe('timeout');
    rmSync(intermediate);
    mkdirSync(intermediate);
    await sleep(30);
    writeFileSync(target, 'leaf file');
    expect(await within(waitNested, 2_000)).toBeUndefined();

    // Parent deletion while watching under match: entry re-parents watch and still wakes on recreation
    const removableParent = join(root, 'rem-parent');
    mkdirSync(removableParent);
    const childEntry = join(removableParent, 'sock');
    const waitAfterDelete = waitForDirectory(childEntry, { match: 'entry', settleMs: 20 });
    await sleep(30);
    rmSync(removableParent, { recursive: true });
    await sleep(40);
    mkdirSync(removableParent);
    await sleep(30);
    writeFileSync(childEntry, 'recreated');
    expect(await within(waitAfterDelete, 2_000)).toBeUndefined();

    // Idle stability under match: entry — neither checks nor watches grow after settleMs
    const { io, counts } = countingIo();
    const controller = new AbortController();
    const idleWait = waitForDirectoryWith(io, join(root, 'idle-missing', 'conf.d'), {
      match: 'entry',
      settleMs: 20,
      signal: controller.signal,
    });
    await sleep(100);
    const settledChecks = counts.checks;
    const settledWatches = counts.watches;
    await sleep(300);
    expect(counts.checks).toBe(settledChecks);
    expect(counts.watches).toBe(settledWatches);
    controller.abort(new Error('cancel-entry'));
    await expect(idleWait).rejects.toThrow('cancel-entry');
    expect(counts.open).toBe(0);
  });

  test('validates match and io.hasEntry synchronously and propagates EACCES from hasEntry', async () => {
    expect(() =>
      waitForDirectoryWith(countingIo().io, join(root, 'x'), {
        match: 'other' as unknown as 'entry',
      }),
    ).toThrow(TypeError);
    const noEntryIo: DirectoryAppearanceIo = {
      isDirectory: () => false,
      watch: () => ({
        close() {
          // no-op
        },
        on() {
          return this;
        },
      }),
    };
    expect(() => waitForDirectoryWith(noEntryIo, join(root, 'x'), { match: 'entry' })).toThrow(
      TypeError,
    );
    const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const failingIo: DirectoryAppearanceIo = {
      isDirectory: () => false,
      hasEntry: () => {
        throw eacces;
      },
      watch: () => ({
        close() {
          // no-op
        },
        on() {
          return this;
        },
      }),
    };
    await expect(
      waitForDirectoryWith(failingIo, join(root, 'x'), { match: 'entry' }),
    ).rejects.toBe(eacces);
  });
});
