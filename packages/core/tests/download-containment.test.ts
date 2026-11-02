import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createCli } from '../src/entrypoints/cli';
import { openPinnedDirectory } from '../src/internal/contained-directory';
import { openContainedParent } from '../src/internal/contained-files';
import { writeContainedFile } from '../src/internal/contained-write';
import { writeDownload } from '../src/internal/write-download';
import { reapAfterEachTest, trackPidFile } from './support/process-reaper';

reapAfterEachTest();
let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'sk-contained-download-')));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('download filesystem capability', () => {
  test('writes exact binary subarray bytes and an empty file', async () => {
    const directory = await openPinnedDirectory(root);
    try {
      const bytes = new Uint8Array([99, 0, 255, 128, 42, 99]).subarray(1, 5);
      await writeDownload(directory, 'binary', bytes);
      await writeDownload(directory, 'empty', new Uint8Array());
      expect(new Uint8Array(await readFile(join(root, 'binary')))).toEqual(
        new Uint8Array([0, 255, 128, 42]),
      );
      expect((await stat(join(root, 'empty'))).size).toBe(0);
    } finally {
      await directory.close();
    }
  });

  test('replaces leaf, dangling and hard links without changing an external inode', async () => {
    const downloads = join(root, 'downloads');
    await mkdir(downloads);
    const outside = join(root, 'outside');
    await writeFile(outside, 'original');
    const identity = await stat(outside);
    await symlink(outside, join(downloads, 'link'));
    await symlink(join(root, 'absent'), join(downloads, 'dangling'));
    await link(outside, join(downloads, 'hard'));
    const directory = await openPinnedDirectory(downloads);
    try {
      for (const name of ['link', 'dangling', 'hard']) {
        await writeDownload(directory, name, new Uint8Array([0, 255]));
        expect((await lstat(join(downloads, name))).isSymbolicLink()).toBe(false);
        expect(new Uint8Array(await readFile(join(downloads, name)))).toEqual(
          new Uint8Array([0, 255]),
        );
      }
      expect(await readFile(outside, 'utf8')).toBe('original');
      expect((await stat(outside)).ino).toBe(identity.ino);
      expect(
        await lstat(join(root, 'absent')).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    } finally {
      await directory.close();
    }
  });

  test('refuses descendant parent links, including a dangling link', async () => {
    const outside = join(root, 'outside');
    await mkdir(outside);
    const downloads = join(root, 'downloads');
    await mkdir(downloads);
    await symlink(outside, join(downloads, 'parent'));
    await symlink(join(root, 'missing'), join(downloads, 'dangling'));
    for (const name of ['parent/file', 'dangling/file']) {
      await expect(
        openContainedParent(downloads, name, {
          createDirectories: [name.split('/')[0] ?? ''],
        }),
      ).rejects.toThrow();
    }
    expect(await readdir(outside)).toEqual([]);
    expect(
      await lstat(join(root, 'missing')).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  test('a selected root alias is allowed and a missing root is created through pinned parents', async () => {
    await symlink(root, join(root, 'alias'));
    const directory = await openPinnedDirectory(join(root, 'alias', 'new', 'nested'), {
      create: true,
    });
    try {
      await writeDownload(directory, 'file', new Uint8Array([7]));
    } finally {
      await directory.close();
    }
    expect(new Uint8Array(await readFile(join(root, 'new/nested/file')))).toEqual(
      new Uint8Array([7]),
    );
  });

  test('an ancestor changed to a symlink after canonical selection cannot redirect root creation', async () => {
    const anchor = join(root, 'anchor');
    await mkdir(anchor);
    const outside = join(root, 'outside');
    await mkdir(outside);
    const moved = join(root, 'moved');
    let selected = false;
    await expect(
      openPinnedDirectory(
        join(anchor, 'new/nested'),
        { create: true },
        {
          async realpath(path) {
            const canonical = await realpath(path);
            if (!selected) {
              selected = true;
              await rename(anchor, moved);
              await symlink(outside, anchor);
            }
            return canonical;
          },
        },
      ),
    ).rejects.toThrow();
    expect(selected).toBe(true);
    expect(await readdir(outside)).toEqual([]);
    expect(await readdir(moved)).toEqual([]);
  });

  test('root and parent replacement after pin writes only through the original capability', async () => {
    const anchor = join(root, 'anchor');
    await mkdir(anchor);
    const directory = await openPinnedDirectory(join(anchor, 'downloads'), { create: true });
    const outside = join(root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'file'), 'external');
    await rename(anchor, join(root, 'moved'));
    await symlink(outside, anchor);
    try {
      await writeDownload(directory, 'file', new Uint8Array([42]));
    } finally {
      await directory.close();
    }
    expect(await readFile(join(outside, 'file'), 'utf8')).toBe('external');
    expect(new Uint8Array(await readFile(join(root, 'moved/downloads/file')))).toEqual(
      new Uint8Array([42]),
    );
  });

  test('preserves regular file permissions and honours umask for new files', async () => {
    const target = join(root, 'private');
    await writeFile(target, 'old');
    await chmod(target, 0o600);
    const directory = await openPinnedDirectory(root);
    const previous = process.umask(0o077);
    try {
      await writeDownload(directory, 'private', new Uint8Array([1]));
      await writeDownload(directory, 'new', new Uint8Array([2]));
      expect((await stat(target)).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, 'new'))).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previous);
      await directory.close();
    }
  });

  test('a directory refusal keeps its contents and removes only owned staging', async () => {
    const target = join(root, 'occupied');
    await mkdir(target);
    await writeFile(join(target, 'inside'), 'kept');
    const directory = await openPinnedDirectory(root);
    try {
      await expect(
        writeDownload(directory, 'occupied', new Uint8Array([1])),
      ).rejects.toThrow();
    } finally {
      await directory.close();
    }
    expect(await readdir(root)).toEqual(['occupied']);
    expect(await readFile(join(target, 'inside'), 'utf8')).toBe('kept');
  });

  test('exclusive contained writes refuse existing files without replacement', async () => {
    const directory = await openPinnedDirectory(root);
    try {
      const parent = { handle: directory, basename: 'file' };
      await writeContainedFile({ parent, content: 'first', replace: false });
      await expect(
        writeContainedFile({ parent, content: 'second', replace: false }),
      ).rejects.toThrow();
      expect(await readFile(join(root, 'file'), 'utf8')).toBe('first');
      expect(await readdir(root)).toEqual(['file']);
      for (const invalid of ['', '.', '..', '../escape', 'nested/file', 'bad\0name']) {
        await expect(writeDownload(directory, invalid, new Uint8Array([1]))).rejects.toThrow();
      }
    } finally {
      await directory.close();
    }
  });
});

/** Bytes whose first read runs `during`, inside the write and after the file was opened. */
function bytesObserving(during: () => void): Uint8Array {
  const bytes = new Uint8Array([1]);
  Object.defineProperty(bytes, 'byteLength', {
    get() {
      during();
      return 1;
    },
  });
  return bytes;
}

test('exclusive creation opens the final name, so it needs no hard link to publish', async () => {
  const directory = await openPinnedDirectory(root);
  let during: string[] = [];
  try {
    await writeContainedFile({
      parent: { handle: directory, basename: 'file' },
      content: bytesObserving(() => {
        during = readdirSync(root);
      }),
      replace: false,
    });
  } finally {
    await directory.close();
  }
  expect(during).toEqual(['file']);
  expect(await readdir(root)).toEqual(['file']);
});

test('a losing exclusive create removes nothing, and a failed write removes only its own file', async () => {
  await writeFile(join(root, 'taken'), 'theirs');
  const directory = await openPinnedDirectory(root);
  try {
    await expect(
      writeContainedFile({
        parent: { handle: directory, basename: 'taken' },
        content: 'mine',
        replace: false,
      }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(join(root, 'taken'), 'utf8')).toBe('theirs');
    await expect(
      writeContainedFile({
        parent: { handle: directory, basename: 'failed' },
        content: bytesObserving(() => {
          throw new Error('write failed');
        }),
        replace: false,
      }),
    ).rejects.toThrow('write failed');
    expect(await readdir(root)).toEqual(['taken']);
  } finally {
    await directory.close();
  }
});

test('a cleanup that cannot remove the file leaves the write failure as the report', async () => {
  const directory = await openPinnedDirectory(root);
  try {
    await expect(
      writeContainedFile({
        parent: { handle: directory, basename: 'file' },
        content: bytesObserving(() => {
          renameSync(join(root, 'file'), join(root, 'moved'));
          mkdirSync(join(root, 'file'));
          throw new Error('write failed');
        }),
        replace: false,
      }),
    ).rejects.toThrow('write failed');
    expect((await stat(join(root, 'file'))).isDirectory()).toBe(true);
  } finally {
    await directory.close();
  }
});

test('an unsupported backend refuses downloads while ordinary public CLI commands remain portable', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!platform) throw new Error('Missing platform descriptor');
  let code = -1;
  let output = '';
  let error = '';
  let calls = 0;
  const run = (download: boolean) =>
    createCli({
      name: 'portable',
      version: '1',
      runtimeTools: [
        {
          name: 'media',
          description: 'Media',
          identity: { serviceName: 'media', action: 'get', method: 'GET' },
          transports: ['CLI'],
          input: z.object({}),
          output: z.object({ ok: z.boolean() }),
          handler: () => {
            calls++;
            return { ok: true };
          },
        },
      ],
      argv: ['media', ...(download ? ['--output-dir', root] : [])],
      stdin: async () => null,
      stdout: (text) => {
        output += text;
      },
      stderr: (text) => {
        error += text;
      },
      exit: (value) => {
        code = value;
      },
      download: () => [{ url: 'http://127.0.0.1:1/never-connect', name: 'file' }],
    });
  try {
    // Exercise the exact public branch; this does not claim to execute on a Windows host.
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    await run(true);
    expect(code).not.toBe(0);
    expect(error).toContain('Linux and macOS');
    expect(JSON.parse(output)).toEqual({ ok: true });
    expect(await readdir(root)).toEqual([]);
    output = '';
    error = '';
    await run(false);
    expect(code).toBe(0);
    expect(error).toBe('');
    expect(JSON.parse(output)).toEqual({ ok: true });
    expect(calls).toBe(2);
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
});

test('shared contained writer defaults honour umask for both exclusive and replacing creation', async () => {
  const directory = await openPinnedDirectory(root);
  const oldMask = process.umask(0o077);
  try {
    for (const replace of [false, true]) {
      const name = replace ? 'replace' : 'exclusive';
      await writeContainedFile({
        parent: { handle: directory, basename: name },
        content: 'private',
        replace,
      });
      expect((await stat(join(root, name))).mode & 0o777).toBe(0o600);
    }
    await writeContainedFile({
      parent: { handle: directory, basename: 'explicit' },
      content: 'explicit',
      replace: false,
      mode: 0o750,
    });
    expect((await stat(join(root, 'explicit'))).mode & 0o777).toBe(0o750);
  } finally {
    process.umask(oldMask);
    await directory.close();
  }
});

test.skipIf(process.platform !== 'linux')(
  'search-only ancestors admit a permitted root without granting read permission',
  async () => {
    await chmod(root, 0o777);
    const search = join(root, 'search');
    await mkdir(search);
    await chmod(search, 0o711);
    const output = join(search, 'output');
    await mkdir(output);
    await chmod(output, 0o777);
    const pid = join(root, 'child.pid');
    trackPidFile(pid);
    const source = join(root, 'permissions.ts');
    await writeFile(
      source,
      `
    import { writeFileSync } from 'node:fs';
    import { writeFile, open, readFile } from 'node:fs/promises';
    import { openPinnedDirectory } from ${JSON.stringify(fileURLToPath(new URL('../src/internal/contained-directory.ts', import.meta.url)))};
    import { writeDownload } from ${JSON.stringify(fileURLToPath(new URL('../src/internal/write-download.ts', import.meta.url)))};
    writeFileSync(process.argv[3], String(process.pid));
    const direct = await open(process.argv[2], 'r'); await direct.close();
    await writeFile(process.argv[2] + '/ordinary', 'ordinary');
    const capability = await openPinnedDirectory(process.argv[2]);
    try { await writeDownload(capability, 'contained', new Uint8Array([0,255])); }
    finally { await capability.close(); }
    console.log(JSON.stringify(Array.from(await readFile(process.argv[2] + '/contained'))));
  `,
    );
    const built = await Bun.build({ entrypoints: [source], outdir: root, target: 'node' });
    expect(built.success).toBe(true);
    const entry = built.outputs[0];
    if (!entry) throw new Error('Missing permission probe');
    const node = Bun.which('node');
    if (!node) throw new Error('Node is required');
    const privilege = process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {};
    const result = spawnSync(node, [entry.path, output, pid], {
      encoding: 'utf8',
      timeout: 10000,
      ...privilege,
    });
    expect({ code: result.status, out: result.stdout.trim(), error: result.stderr }).toEqual({
      code: 0,
      out: '[0,255]',
      error: '',
    });
    // When the ancestor has no search permission the same child must fail; root can still clean up.
    await chmod(search, 0o600);
    try {
      const denied = spawnSync(node, [entry.path, output, pid], {
        encoding: 'utf8',
        timeout: 10000,
        ...privilege,
      });
      expect(denied.status).not.toBe(0);
      expect(denied.stderr).toContain('EACCES');
    } finally {
      await chmod(search, 0o711);
    }
  },
);

test('contained and download writes never read or change the process umask', async () => {
  const directory = await openPinnedDirectory(root);
  const previous = process.umask(0o077);
  const umask = spyOn(process, 'umask').mockImplementation(() => {
    throw new Error('filesystem writes must leave process umask untouched');
  });
  try {
    for (const replace of [false, true]) {
      const name = replace ? 'replacement' : 'exclusive-default';
      await writeContainedFile({
        parent: { handle: directory, basename: name },
        content: 'private',
        replace,
      });
      expect((await stat(join(root, name))).mode & 0o777).toBe(0o600);
    }
    await writeContainedFile({
      parent: { handle: directory, basename: 'exact' },
      content: 'explicit',
      replace: false,
      mode: 0o750,
    });
    expect((await stat(join(root, 'exact'))).mode & 0o777).toBe(0o750);
    await writeDownload(directory, 'download', new Uint8Array([0, 255]));
    expect((await stat(join(root, 'download'))).mode & 0o777).toBe(0o600);
    await writeDownload(directory, 'download', new Uint8Array([42]));
    expect((await stat(join(root, 'download'))).mode & 0o777).toBe(0o600);
    expect(new Uint8Array(await readFile(join(root, 'download')))).toEqual(
      new Uint8Array([42]),
    );
    expect(umask).not.toHaveBeenCalled();
  } finally {
    umask.mockRestore();
    process.umask(previous);
    await directory.close();
  }
});
