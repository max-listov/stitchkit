import { afterEach, beforeEach, expect, test } from 'bun:test';
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
import { publishAtomicFile } from '../src/internal/atomic-publication';

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
      publishAtomicFile(staged, target, true, true, {
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
      }),
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
    await publishAtomicFile(staged, target, false, durable, {
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
    });
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
        publish: async (staged, target, replace, directorySync) => {
          events.push('publish');
          await publishAtomicFile(staged, target, replace, directorySync, {
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
