import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
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
import {
  AUDIO,
  AUDIO_BYTES,
  IMAGE,
  IMAGE_BYTES,
  runMediaCli,
  savedLink,
} from './support/cli-media';

let root: string;
const servers: Bun.Server<undefined>[] = [];
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'sk-cli-inline-boundary-')));
});
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  await rm(root, { recursive: true, force: true });
});

function mediaServer(fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch });
  servers.push(server);
  return `http://127.0.0.1:${server.port}/media`;
}

test('one URL and inline batch pins one root before a URL fetch replaces its pathname', async () => {
  const output = join(root, 'output');
  const moved = join(root, 'moved');
  const outside = join(root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'inline.png'), 'external image');
  await writeFile(join(outside, 'url.png'), 'external download');
  let swapped = false;
  const url = mediaServer(async () => {
    await rename(output, moved);
    await symlink(outside, output);
    swapped = true;
    return new Response(IMAGE_BYTES);
  });
  const data = { content: [{ ...IMAGE, name: 'inline.png' }] };
  const result = await runMediaCli(data, ['media', '--output-dir', output], {
    download: () => [{ url, name: 'url.png' }],
    allowPrivateDownloadHosts: true,
  });
  expect(swapped).toBe(true);
  expect(result.code).toBe(0);
  expect(result.err.match(/^saved /gm)).toHaveLength(2);
  expect((await readdir(moved)).sort()).toEqual(['inline.png', 'url.png']);
  for (const name of ['inline.png', 'url.png']) {
    expect(new Uint8Array(await readFile(join(moved, name)))).toEqual(IMAGE_BYTES);
  }
  expect(await readFile(join(outside, 'inline.png'), 'utf8')).toBe('external image');
  expect(await readFile(join(outside, 'url.png'), 'utf8')).toBe('external download');
  // The link names the root as it was typed: a display path, like the `saved` line.
  expect(JSON.parse(result.out)).toEqual({
    content: [savedLink(output, 'inline.png', 'image/png', IMAGE_BYTES.length)],
  });
});

test('URL and inline writes replace leaf symlinks, dangling links and hardlinks without escape', async () => {
  const url = mediaServer(() => new Response(IMAGE_BYTES));
  for (const source of ['url', 'inline']) {
    const output = join(root, source);
    await mkdir(output);
    const outside = join(root, `${source}-outside`);
    const absent = join(root, `${source}-absent`);
    await writeFile(outside, 'original');
    const inode = (await stat(outside)).ino;
    await symlink(outside, join(output, 'link'));
    await symlink(absent, join(output, 'dangling'));
    await link(outside, join(output, 'hard'));
    const names = ['link', 'dangling', 'hard'];
    const result = await runMediaCli(
      {
        content: source === 'inline' ? names.map((name) => ({ ...IMAGE, name })) : [],
      },
      ['media', '--output-dir', output],
      {
        ...(source === 'url' && { download: () => names.map((name) => ({ url, name })) }),
        allowPrivateDownloadHosts: true,
      },
    );
    expect(result.code).toBe(0);
    for (const name of names) {
      expect((await lstat(join(output, name))).isSymbolicLink()).toBe(false);
      expect(new Uint8Array(await readFile(join(output, name)))).toEqual(IMAGE_BYTES);
    }
    expect(await readFile(outside, 'utf8')).toBe('original');
    expect((await stat(outside)).ino).toBe(inode);
    expect(
      await lstat(absent).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect((await readdir(output)).sort()).toEqual(names.toSorted());
  }
});

test('URL and inline directory refusals preserve contents, clean staging and continue the batch', async () => {
  const url = mediaServer(() => new Response(IMAGE_BYTES));
  for (const source of ['url', 'inline']) {
    const output = join(root, source);
    await mkdir(join(output, 'occupied'), { recursive: true });
    await writeFile(join(output, 'occupied', 'inside'), 'kept');
    const names = ['occupied', 'valid.png'];
    const data = {
      content: source === 'inline' ? names.map((name) => ({ ...IMAGE, name })) : [],
    };
    const result = await runMediaCli(data, ['media', '--output-dir', output], {
      ...(source === 'url' && { download: () => names.map((name) => ({ url, name })) }),
      allowPrivateDownloadHosts: true,
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain(
      source === 'url'
        ? `failed to download ${url}: EISDIR\n`
        : 'failed to save content[0]: EISDIR\n',
    );
    expect(result.err.match(/^saved /gm)).toHaveLength(1);
    expect((await readdir(output)).sort()).toEqual(['occupied', 'valid.png']);
    expect(await readFile(join(output, 'occupied', 'inside'), 'utf8')).toBe('kept');
    expect(new Uint8Array(await readFile(join(output, 'valid.png')))).toEqual(IMAGE_BYTES);
    // A refused inline block keeps its bytes on stdout; the saved one is a link.
    expect(JSON.parse(result.out)).toEqual({
      content: data.content.map((part) =>
        part.name === 'valid.png'
          ? savedLink(output, 'valid.png', 'image/png', IMAGE_BYTES.length)
          : part,
      ),
    });
  }
});

test('invalid inline leaf names fail without saved while a neighbouring safe file survives', async () => {
  const data = {
    content: [
      ...['', '.', '..', 'bad\0name'].map((name) => ({ ...IMAGE, name })),
      { ...IMAGE, name: '../../safe.png' },
    ],
  };
  const result = await runMediaCli(data, ['media', '--output-dir', root]);
  expect(result.code).toBe(1);
  expect(result.err.match(/^failed to save content\[[0-3]\]: /gm)).toHaveLength(4);
  expect(result.err.match(/^saved /gm)).toHaveLength(1);
  expect(await readdir(root)).toEqual(['safe.png']);
  expect(new Uint8Array(await readFile(join(root, 'safe.png')))).toEqual(IMAGE_BYTES);
});

test('a mixed URL, malformed image and valid audio batch keeps good files and exits nonzero', async () => {
  const url = mediaServer(() => new Response(IMAGE_BYTES));
  const data = {
    content: [
      { ...IMAGE, data: '!!' },
      { ...AUDIO, name: 'voice.ogg' },
    ],
  };
  const result = await runMediaCli(data, ['media', '--output-dir', root, '--json'], {
    download: () => [{ url, name: 'remote.png' }],
    allowPrivateDownloadHosts: true,
  });
  expect(result.code).toBe(1);
  expect(result.err).toContain('invalid base64');
  expect(result.err.match(/^saved /gm)).toHaveLength(2);
  expect((await readdir(root)).sort()).toEqual(['remote.png', 'voice.ogg']);
  expect(new Uint8Array(await readFile(join(root, 'remote.png')))).toEqual(IMAGE_BYTES);
  expect(new Uint8Array(await readFile(join(root, 'voice.ogg')))).toEqual(AUDIO_BYTES);
  expect(result.out).toBe(
    `${JSON.stringify({
      content: [
        data.content[0],
        savedLink(root, 'voice.ogg', 'audio/ogg', AUDIO_BYTES.length),
      ],
    })}\n`,
  );
});

test('a URL and an inline block share the one-name rule of their batch', async () => {
  const url = mediaServer(() => new Response(IMAGE_BYTES));
  const config = {
    download: () => [
      { url, name: 'shared.png' },
      { url, name: 'again/shared.png' },
    ],
    allowPrivateDownloadHosts: true,
  };
  // The same bytes under the same name are one file, saved once.
  const same = await runMediaCli(
    { content: [{ ...IMAGE, name: 'shared.png' }] },
    ['media', '--output-dir', root, '--json'],
    config,
  );
  expect(same).toEqual({
    out: `${JSON.stringify({
      content: [savedLink(root, 'shared.png', 'image/png', IMAGE_BYTES.length)],
    })}\n`,
    err: `saved ${join(root, 'shared.png')} (0KB)\n`,
    code: 0,
  });
  // Other bytes under that name are refused: the downloaded file is not replaced.
  const other = { ...AUDIO, name: 'shared.png' };
  const refused = await runMediaCli(
    { content: [other] },
    ['media', '--output-dir', root, '--json'],
    config,
  );
  expect(refused).toEqual({
    out: `${JSON.stringify({ content: [other] })}\n`,
    err:
      `saved ${join(root, 'shared.png')} (0KB)\n` +
      'failed to save content[0]: another file of this batch is already saved as "shared.png"\n',
    code: 1,
  });
  expect(await readdir(root)).toEqual(['shared.png']);
  expect(new Uint8Array(await readFile(join(root, 'shared.png')))).toEqual(IMAGE_BYTES);
});

test('two downloads of different bytes under one name keep the first and name the refused URL', async () => {
  let served = 0;
  const url = mediaServer(() => new Response(new Uint8Array([++served])));
  const result = await runMediaCli({}, ['media', '--output-dir', root], {
    download: () => [
      { url: `${url}?first`, name: 'file.bin' },
      { url: `${url}?second`, name: 'file.bin' },
    ],
    allowPrivateDownloadHosts: true,
  });
  expect(result.code).toBe(1);
  expect(result.err).toBe(
    `saved ${join(root, 'file.bin')} (0KB)\n` +
      `failed to download ${url}?second: another file of this batch is already saved as "file.bin"\n`,
  );
  expect(new Uint8Array(await readFile(join(root, 'file.bin')))).toEqual(new Uint8Array([1]));
});
