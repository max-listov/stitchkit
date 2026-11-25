/**
 * Current-path confirmation after reading a regular file:
 * - leaf symlink retarget and parent-directory symlink swap during accept/read
 * - single bounded retry recovering current bytes across sync, async, JSON, and polled readers
 * - persistent swap refusal (`changed`), stable single-attempt path, `noFollow`, user `changed`
 *   not retried, deterministic `namedStat` failures, and abort hygiene.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  PolledJsonFile,
  PolledJsonFiles,
  RegularFileError,
  readJsonFileSync,
  readJsonOnce,
  readRegularFile,
  readRegularFileSync,
} from '../src/entrypoints/files';
import {
  readRegularFileFromOpen,
  readRegularFileWithMetaSync,
} from '../src/files/regular-file';

const ValueSchema = z.strictObject({ version: z.string() });

function swapSymlink(linkPath: string, newTarget: string, tmpLinkPath: string): void {
  try {
    unlinkSync(tmpLinkPath);
  } catch {
    // Ignore absent staging link.
  }
  symlinkSync(newTarget, tmpLinkPath);
  renameSync(tmpLinkPath, linkPath);
}

describe('current-path confirmation after regular-file read', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stitchkit-file-snapshot-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('leaf symlink retarget during accept recovers new bytes in sync, async, JSON, and polled readers', async () => {
    const oldFile = join(root, 'old.json');
    const newFile = join(root, 'new.json');
    const link = join(root, 'current.json');
    const tmp = join(root, '.swap-link');
    writeFileSync(oldFile, JSON.stringify({ version: 'old' }));
    writeFileSync(newFile, JSON.stringify({ version: 'new' }));

    // 1. readRegularFileSync
    swapSymlink(link, oldFile, tmp);
    let syncChecks = 0;
    const syncBytes = readRegularFileSync(link, {
      accept: () => {
        syncChecks += 1;
        if (syncChecks === 1) swapSymlink(link, newFile, tmp);
        return true;
      },
    });
    expect(syncChecks).toBe(2);
    expect(JSON.parse(new TextDecoder().decode(syncBytes))).toEqual({ version: 'new' });

    // 2. readRegularFile (async)
    swapSymlink(link, oldFile, tmp);
    let asyncChecks = 0;
    const asyncBytes = await readRegularFile(link, {
      accept: () => {
        asyncChecks += 1;
        if (asyncChecks === 1) swapSymlink(link, newFile, tmp);
        return true;
      },
    });
    expect(asyncChecks).toBe(2);
    expect(JSON.parse(new TextDecoder().decode(asyncBytes))).toEqual({ version: 'new' });

    // 3. readJsonFileSync
    swapSymlink(link, oldFile, tmp);
    let jsonSyncChecks = 0;
    const parsedSync = readJsonFileSync(link, ValueSchema, {
      accept: () => {
        jsonSyncChecks += 1;
        if (jsonSyncChecks === 1) swapSymlink(link, newFile, tmp);
        return true;
      },
    });
    expect(jsonSyncChecks).toBe(2);
    expect(parsedSync).toEqual({ version: 'new' });

    // 4. readJsonOnce (sync)
    swapSymlink(link, oldFile, tmp);
    let jsonOnceChecks = 0;
    const parsedOnce = readJsonOnce(link, ValueSchema, {
      accept: () => {
        jsonOnceChecks += 1;
        if (jsonOnceChecks === 1) swapSymlink(link, newFile, tmp);
        return true;
      },
    });
    expect(jsonOnceChecks).toBe(2);
    expect(parsedOnce).toMatchObject({ state: 'read', value: { version: 'new' } });

    // 5. PolledJsonFile
    swapSymlink(link, oldFile, tmp);
    let polledChecks = 0;
    const polled = new PolledJsonFile(link, ValueSchema, {
      accept: () => {
        polledChecks += 1;
        if (polledChecks === 1) swapSymlink(link, newFile, tmp);
        return true;
      },
    });
    expect(polled.read()).toMatchObject({ state: 'read', value: { version: 'new' } });
    expect(polledChecks).toBe(2);

    // 6. PolledJsonFiles.refreshAsync
    swapSymlink(link, oldFile, tmp);
    let refreshChecks = 0;
    const set = new PolledJsonFiles(ValueSchema, {
      accept: () => {
        refreshChecks += 1;
        if (refreshChecks === 1) swapSymlink(link, newFile, tmp);
        return true;
      },
    });
    const changes = await set.refreshAsync([{ path: link }]);
    expect(refreshChecks).toBe(2);
    expect(changes).toMatchObject([
      { kind: 'changed', path: link, reading: { state: 'read', value: { version: 'new' } } },
    ]);
  });

  test('parent-directory symlink swap during accept recovers new bytes across sync, async, JSON and polled paths', async () => {
    const dirA = join(root, 'dir-a');
    const dirB = join(root, 'dir-b');
    mkdirSync(dirA);
    mkdirSync(dirB);
    writeFileSync(join(dirA, 'config.json'), JSON.stringify({ version: 'a' }));
    writeFileSync(join(dirB, 'config.json'), JSON.stringify({ version: 'b' }));
    const dirLink = join(root, 'active-dir');
    const tmp = join(root, '.swap-dir');
    const target = join(dirLink, 'config.json');

    swapSymlink(dirLink, dirA, tmp);
    let syncChecks = 0;
    expect(
      readJsonFileSync(target, ValueSchema, {
        accept: () => {
          syncChecks += 1;
          if (syncChecks === 1) swapSymlink(dirLink, dirB, tmp);
          return true;
        },
      }),
    ).toEqual({ version: 'b' });
    expect(syncChecks).toBe(2);

    swapSymlink(dirLink, dirA, tmp);
    let asyncChecks = 0;
    expect(
      await readJsonOnce(target, ValueSchema, {
        accept: () => {
          asyncChecks += 1;
          if (asyncChecks === 1) swapSymlink(dirLink, dirB, tmp);
          return true;
        },
      }),
    ).toMatchObject({ state: 'read', value: { version: 'b' } });
    expect(asyncChecks).toBe(2);

    swapSymlink(dirLink, dirA, tmp);
    let setChecks = 0;
    const polledSet = new PolledJsonFiles(ValueSchema, {
      accept: () => {
        setChecks += 1;
        if (setChecks === 1) swapSymlink(dirLink, dirB, tmp);
        return true;
      },
    });
    const changes = await polledSet.refreshAsync([{ path: target }]);
    expect(setChecks).toBe(2);
    expect(changes).toMatchObject([
      { kind: 'changed', path: target, reading: { state: 'read', value: { version: 'b' } } },
    ]);
  });

  test('persistent symlink retarget across both attempts refuses changed without returning stale bytes', async () => {
    const f1 = join(root, 'f1.txt');
    const f2 = join(root, 'f2.txt');
    const f3 = join(root, 'f3.txt');
    writeFileSync(f1, 'v1');
    writeFileSync(f2, 'v2');
    writeFileSync(f3, 'v3');
    const link = join(root, 'moving.txt');
    const tmp = join(root, '.swap');

    swapSymlink(link, f1, tmp);
    let syncAttempt = 0;
    try {
      readRegularFileSync(link, {
        accept: () => {
          syncAttempt += 1;
          swapSymlink(link, syncAttempt === 1 ? f2 : f3, tmp);
          return true;
        },
      });
      throw new Error('expected RegularFileError(changed)');
    } catch (error) {
      expect(error).toBeInstanceOf(RegularFileError);
      expect((error as RegularFileError).reason).toBe('changed');
    }
    expect(syncAttempt).toBe(2);

    swapSymlink(link, f1, tmp);
    let asyncAttempt = 0;
    try {
      await readRegularFile(link, {
        accept: () => {
          asyncAttempt += 1;
          swapSymlink(link, asyncAttempt === 1 ? f2 : f3, tmp);
          return true;
        },
      });
      throw new Error('expected RegularFileError(changed)');
    } catch (error) {
      expect(error).toBeInstanceOf(RegularFileError);
      expect((error as RegularFileError).reason).toBe('changed');
    }
    expect(asyncAttempt).toBe(2);
  });

  test('stable path reads in one attempt; noFollow still refuses symlinks; accept-thrown changed is not retried', async () => {
    const file = join(root, 'stable.txt');
    const link = join(root, 'link.txt');
    writeFileSync(file, 'steady');
    symlinkSync(file, link);

    let syncCalls = 0;
    expect(
      new TextDecoder().decode(
        readRegularFileSync(link, {
          accept: () => {
            syncCalls += 1;
            return true;
          },
        }),
      ),
    ).toBe('steady');
    expect(syncCalls).toBe(1);

    let asyncCalls = 0;
    expect(
      new TextDecoder().decode(
        await readRegularFile(link, {
          accept: () => {
            asyncCalls += 1;
            return true;
          },
        }),
      ),
    ).toBe('steady');
    expect(asyncCalls).toBe(1);

    // Replacing a regular file with a symlink while noFollow is active refuses as symbolic-link on retry.
    const nf = join(root, 'nf.txt');
    const other = join(root, 'other.txt');
    writeFileSync(nf, 'first');
    writeFileSync(other, 'second');
    let nfCalls = 0;
    try {
      readRegularFileSync(nf, {
        noFollow: true,
        accept: () => {
          nfCalls += 1;
          unlinkSync(nf);
          symlinkSync(other, nf);
          return true;
        },
      });
      throw new Error('expected symbolic-link');
    } catch (error) {
      expect(error).toBeInstanceOf(RegularFileError);
      expect((error as RegularFileError).reason).toBe('symbolic-link');
    }
    expect(nfCalls).toBe(1);

    // A caller-thrown RegularFileError('changed') from accept must not trigger a retry.
    let thrownCalls = 0;
    try {
      readRegularFileSync(file, {
        accept: () => {
          thrownCalls += 1;
          throw new RegularFileError('changed', 'caller refused');
        },
      });
      throw new Error('expected changed');
    } catch (error) {
      expect(error).toBeInstanceOf(RegularFileError);
      expect((error as RegularFileError).message).toBe('caller refused');
    }
    expect(thrownCalls).toBe(1);
  });

  test('deterministic namedStat hooks handle non-regular/ENOENT/EACCES and abort before namedStat', async () => {
    const file = join(root, 'snap.txt');
    writeFileSync(file, 'data');
    const info = statSync(file, { bigint: true });

    // Non-regular namedStat on attempt 1 -> retries and succeeds on attempt 2
    let syncStatCalls = 0;
    const syncOut = readRegularFileWithMetaSync(file, {}, undefined, {
      namedStatSync: () => {
        syncStatCalls += 1;
        return syncStatCalls === 1
          ? { dev: info.dev, ino: info.ino, isFile: () => false }
          : { dev: info.dev, ino: info.ino, isFile: () => true };
      },
    });
    expect(syncStatCalls).toBe(2);
    expect(new TextDecoder().decode(syncOut.bytes)).toBe('data');

    // EACCES on namedStat propagates directly without retrying
    let eaccesCalls = 0;
    const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    await expect(
      readRegularFileFromOpen(file, {}, open, {
        namedStat: async () => {
          eaccesCalls += 1;
          throw eacces;
        },
      }),
    ).rejects.toBe(eacces);
    expect(eaccesCalls).toBe(1);

    // Abort triggered during read prevents namedStat from running
    const controller = new AbortController();
    let namedCalled = false;
    await expect(
      readRegularFileFromOpen(
        file,
        { signal: controller.signal },
        async (target, flags) => {
          const handle = await open(target, flags);
          return {
            stat: () => handle.stat(),
            read: async (buffer: Uint8Array, offset: number, length: number) => {
              const result = await handle.read(buffer, offset, length);
              if (result.bytesRead === 0)
                controller.abort(new Error('aborted-before-confirm'));
              return result;
            },
            close: () => handle.close(),
          };
        },
        {
          namedStat: async () => {
            namedCalled = true;
            return { dev: info.dev, ino: info.ino, isFile: () => true };
          },
        },
      ),
    ).rejects.toThrow('aborted-before-confirm');
    expect(namedCalled).toBe(false);

    // 64-bit inode above Number.MAX_SAFE_INTEGER preserves exact bigint equality in async confirmNamedPath
    const highIno = 9_007_199_254_740_993n;
    const bigBytes = await readRegularFileFromOpen(
      file,
      {},
      async (target, flags) => {
        const handle = await open(target, flags);
        return {
          stat: async () => {
            const real = await handle.stat({ bigint: true });
            return {
              dev: real.dev,
              ino: highIno,
              size: real.size,
              mtimeMs: real.mtimeMs,
              ctimeMs: real.ctimeMs,
              mtimeNs: real.mtimeNs,
              ctimeNs: real.ctimeNs,
              mode: real.mode,
              uid: real.uid,
              gid: real.gid,
              nlink: real.nlink,
              isFile: () => real.isFile(),
              isDirectory: () => real.isDirectory(),
              isSymbolicLink: () => real.isSymbolicLink(),
            };
          },
          read: handle.read.bind(handle),
          close: () => handle.close(),
        };
      },
      {
        namedStat: async () => ({ dev: info.dev, ino: highIno, isFile: () => true }),
      },
    );
    expect(new TextDecoder().decode(bigBytes)).toBe('data');
  });

  test('PolledJsonFiles.refreshAsync stamps post-retry bytes so reverting a settled symlink is never hidden by a stale stamp', async () => {
    const oldFile = join(root, 'settled-old.json');
    const newFile = join(root, 'settled-new.json');
    const link = join(root, 'settled-link.json');
    const tmp = join(root, '.settled-swap');
    writeFileSync(oldFile, JSON.stringify({ version: 'old' }));
    writeFileSync(newFile, JSON.stringify({ version: 'new' }));
    // Age both files >3s so their stat stamps qualify as settled for the fast-stat cache shortcut.
    const aged = new Date(Date.now() - 10_000);
    utimesSync(oldFile, aged, aged);
    utimesSync(newFile, aged, aged);

    swapSymlink(link, oldFile, tmp);
    let acceptCalls = 0;
    const set = new PolledJsonFiles(ValueSchema, {
      accept: () => {
        acceptCalls += 1;
        if (acceptCalls === 1) swapSymlink(link, newFile, tmp);
        return true;
      },
    });
    const first = await set.refreshAsync([{ path: link }]);
    expect(acceptCalls).toBe(2);
    expect(first).toMatchObject([
      { kind: 'changed', path: link, reading: { state: 'read', value: { version: 'new' } } },
    ]);

    // Now revert the symlink back to the aged oldFile: refreshAsync must detect the revert, not cache-hit oldFile's pre-read stamp.
    swapSymlink(link, oldFile, tmp);
    const second = await set.refreshAsync([{ path: link }]);
    expect(second).toMatchObject([
      { kind: 'changed', path: link, reading: { state: 'read', value: { version: 'old' } } },
    ]);
  });
});
