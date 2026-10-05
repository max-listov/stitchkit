import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  readdirSync,
  readFileSync as readFileSyncNode,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  link,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AtomicFilePublicationError,
  createManagedFileBoundary,
  writeFileAtomic,
  writeFileAtomicSync,
} from '../src/entrypoints/files';
import { publishAtomicFile, publishAtomicFileSync } from '../src/internal/atomic-publication';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'stitchkit-publication-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

for (const [label, write] of [
  ['async', writeFileAtomic],
  [
    'sync',
    async (...args: Parameters<typeof writeFileAtomicSync>) => writeFileAtomicSync(...args),
  ],
] as const) {
  test(`atomic create refuses files and symlinks and directory durability succeeds (${label})`, async () => {
    const target = join(root, 'target');
    await write(target, 'first', { replace: false, durability: 'directory', mode: 0o640 });
    await expect(write(target, 'second', { replace: false })).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('first');
    expect((await stat(target)).nlink).toBe(1);
    await symlink(target, join(root, 'link'));
    await expect(write(join(root, 'link'), 'second', { replace: false })).rejects.toThrow();
    expect((await readdir(root)).sort()).toEqual(['link', 'target']);
  });
}
test('concurrent atomic create admits exactly one complete writer', async () => {
  const target = join(root, 'target');
  const results = await Promise.allSettled(
    Array.from({ length: 16 }, (_, n) =>
      writeFileAtomic(target, `${n}`.repeat(1000), {
        replace: false,
        durability: 'directory',
      }),
    ),
  );
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const bytes = await readFile(target, 'utf8');
  expect(Array.from({ length: 16 }, (_, n) => `${n}`.repeat(1000))).toContain(bytes);
  expect(await readdir(root)).toEqual(['target']);
});

test('post-publication sync failure reports visible target and preserves cause', async () => {
  const staged = join(root, 'stage');
  const target = join(root, 'target');
  await writeFile(staged, 'complete');
  const cause = new Error('injected directory sync failure');
  let closed = false;
  const directory = await open(root, 'r');
  try {
    await expect(
      publishAtomicFile(
        staged,
        target,
        { replace: true, durability: 'directory' },
        {
          rename,
          link,
          unlink,
          open: async () => {
            directory.sync = async () => {
              throw cause;
            };
            const close = directory.close.bind(directory);
            directory.close = async () => {
              closed = true;
              await close();
            };
            return directory;
          },
        },
      ),
    ).rejects.toMatchObject({ published: true, phase: 'directory-sync', cause });
    expect(closed).toBe(true);
    expect(await readFile(target, 'utf8')).toBe('complete');
    expect(cause).not.toBeInstanceOf(AtomicFilePublicationError);
  } finally {
    await directory.close().catch(() => undefined);
  }
});

test('directory durability option syncs after publish and default leaves directory untouched', async () => {
  for (const durable of [false, true]) {
    const events: string[] = [];
    const staged = join(root, `stage-${durable}`);
    const target = join(root, `target-${durable}`);
    await writeFile(staged, 'x');
    await publishAtomicFile(
      staged,
      target,
      { replace: false, durability: durable ? 'directory' : 'file' },
      {
        rename,
        link: async (...args) => {
          await link(...args);
          events.push('link');
        },
        unlink: async (...args) => {
          await unlink(...args);
          events.push('unlink');
        },
        open: async (...args) => {
          const fd = await open(...args);
          const sync = fd.sync.bind(fd);
          fd.sync = async () => {
            events.push('sync');
            await sync();
          };
          return fd;
        },
      },
    );
    expect(events).toEqual(durable ? ['link', 'unlink', 'sync'] : ['link', 'unlink']);
  }
});

test('managed durable create shares publication and strict single-link read', async () => {
  const boundary = await createManagedFileBoundary({ root });
  await boundary.write('receipt', new TextEncoder().encode('ok'), { durable: true });
  const result = await boundary.read('receipt', {
    singleLink: true,
    rejectSymlinks: true,
    stable: true,
    observe: true,
  });
  expect(result.observation?.nlink).toBe(1);
  expect(new TextDecoder().decode(result.bytes)).toBe('ok');
});

test('atomic file fsync precedes publication and a failed precommit sync preserves old target', async () => {
  const { writeAtomicFileData } = await import('../src/internal/atomic-file');
  const target = join(root, 'target');
  await writeFile(target, 'old');
  for (const fail of [true, false]) {
    const events: string[] = [];
    const cause = new Error('file sync failed');
    const operation = writeAtomicFileData(
      target,
      'new',
      { durability: 'directory' },
      {
        open: async (...args) => {
          const fd = await open(...args);
          const sync = fd.sync.bind(fd);
          fd.sync = async () => {
            events.push('file-sync');
            if (fail) throw cause;
            await sync();
          };
          return fd;
        },
        unlink,
        publish: async (staged, target, publication) => {
          events.push('publish');
          await publishAtomicFile(staged, target, publication, {
            rename,
            link,
            unlink,
            open: async (...openArgs) => {
              const fd = await open(...openArgs);
              const sync = fd.sync.bind(fd);
              fd.sync = async () => {
                events.push('directory-sync');
                await sync();
              };
              return fd;
            },
          });
        },
      },
    );
    if (fail) {
      await expect(operation).rejects.toBe(cause);
      expect(await readFile(target, 'utf8')).toBe('old');
      expect(events).toEqual(['file-sync']);
    } else {
      await operation;
      expect(events).toEqual(['file-sync', 'publish', 'directory-sync']);
      expect(await readFile(target, 'utf8')).toBe('new');
    }
    expect(await readdir(root)).toEqual(['target']);
  }
});

test('sync post-publication sync failure reports visible target and preserves cause', () => {
  const staged = join(root, 'stage');
  const target = join(root, 'target');
  writeFileSync(staged, 'complete');
  const cause = new Error('injected directory sync failure');
  let closed = false;
  let thrown: unknown;
  try {
    publishAtomicFileSync(
      staged,
      target,
      { replace: true, durability: 'directory' },
      {
        rename: renameSync,
        link: linkSync,
        unlink: unlinkSync,
        open: (path, flags) => {
          const descriptor = openSync(path, flags);
          return {
            sync: () => {
              throw cause;
            },
            close: () => {
              closed = true;
              closeSync(descriptor);
            },
          };
        },
      },
    );
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject({ published: true, phase: 'directory-sync', cause });
  expect(closed).toBe(true);
  expect(readFileSyncNode(target, 'utf8')).toBe('complete');
  expect(cause).not.toBeInstanceOf(AtomicFilePublicationError);
});

test('sync directory durability option syncs after publish and default leaves directory untouched', () => {
  for (const durable of [false, true]) {
    const events: string[] = [];
    const staged = join(root, `stage-sync-${durable}`);
    const target = join(root, `target-sync-${durable}`);
    writeFileSync(staged, 'x');
    publishAtomicFileSync(
      staged,
      target,
      { replace: false, durability: durable ? 'directory' : 'file' },
      {
        rename: renameSync,
        link: (...args) => {
          linkSync(...args);
          events.push('link');
        },
        unlink: (...args) => {
          unlinkSync(...args);
          events.push('unlink');
        },
        open: (path, flags) => {
          const descriptor = openSync(path, flags);
          return {
            sync: () => {
              events.push('sync');
              fsyncSync(descriptor);
            },
            close: () => closeSync(descriptor),
          };
        },
      },
    );
    expect(events).toEqual(durable ? ['link', 'unlink', 'sync'] : ['link', 'unlink']);
  }
});

test('sync atomic file fsync precedes publication and a failed precommit sync preserves old target', async () => {
  const { writeAtomicFileDataSync } = await import('../src/internal/atomic-file');
  const target = join(root, 'target-precommit');
  writeFileSync(target, 'old');
  for (const fail of [true, false]) {
    const events: string[] = [];
    const cause = new Error('file sync failed');
    const operation = () =>
      writeAtomicFileDataSync(
        target,
        'new',
        { durability: 'directory' },
        {
          open: (path, flags, mode) => {
            const descriptor = openSync(path, flags, mode);
            return {
              write: (bytes, offset, length) => {
                writeFileSync(descriptor, bytes.subarray(offset, offset + length));
                return length;
              },
              chmod: () => undefined,
              sync: () => {
                events.push('file-sync');
                if (fail) throw cause;
                fsyncSync(descriptor);
              },
              close: () => closeSync(descriptor),
            };
          },
          unlink: unlinkSync,
          publish: (staged, to, publication) => {
            events.push('publish');
            publishAtomicFileSync(staged, to, publication, {
              rename: renameSync,
              link: linkSync,
              unlink: unlinkSync,
              open: (path, flags) => {
                const descriptor = openSync(path, flags);
                return {
                  sync: () => {
                    events.push('directory-sync');
                    fsyncSync(descriptor);
                  },
                  close: () => closeSync(descriptor),
                };
              },
            });
          },
        },
      );
    if (fail) {
      expect(operation).toThrow(cause);
      expect(readFileSyncNode(target, 'utf8')).toBe('old');
      expect(events).toEqual(['file-sync']);
    } else {
      operation();
      expect(events).toEqual(['file-sync', 'publish', 'directory-sync']);
      expect(readFileSyncNode(target, 'utf8')).toBe('new');
    }
    expect(readdirSync(root).filter((name) => name.startsWith('.stitchkit-'))).toEqual([]);
  }
});

test('staging does not depend on the length of the target name', async () => {
  const boundary = await createManagedFileBoundary({ root });
  const name = `${'n'.repeat(246)}.json`;
  await boundary.write(name, new TextEncoder().encode('long'));
  expect(new TextDecoder().decode((await boundary.read(name)).bytes)).toBe('long');
  const direct = join(root, `${'d'.repeat(250)}`);
  await writeFileAtomic(direct, 'direct');
  expect(await readFile(direct, 'utf8')).toBe('direct');
  expect(await readdir(root)).not.toContainEqual(expect.stringMatching(/\.tmp$/));
});
