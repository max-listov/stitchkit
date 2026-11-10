import assert from 'node:assert/strict';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCli } from 'stitchkit/cli';
import { z } from 'zod';
import { listenFetchable } from './listen-fetchable.mjs';

const root = await mkdtemp(join(tmpdir(), 'sk-download-contained-'));
const original = Buffer.from('existing external file');
const downloaded = Buffer.from([0, 255, 128, 42]);
let requestHook = async () => undefined;
let requests = 0;
let authorization;
const server = createServer(async (req, res) => {
  requests++;
  authorization = req.headers.authorization;
  await requestHook();
  res.end(downloaded);
});
await listenFetchable(server);
const address = server.address();
assert.ok(address && typeof address === 'object');
const url = `http://127.0.0.1:${address.port}/media`;
async function run(directory, names = ['frame.png'], config = {}) {
  let code = -1;
  let err = '';
  let out = '';
  const originalUmask = process.umask;
  process.umask = () => {
    throw new Error('CLI download must not read or change the process umask');
  };
  try {
    await createCli({
      name: 'contained-download',
      version: '1',
      runtimeTools: [
        {
          name: 'media',
          description: 'Download a media result',
          identity: { serviceName: 'media', action: 'get', method: 'GET' },
          transports: ['CLI'],
          input: z.object({}),
          output: z.object({ ok: z.boolean() }),
          handler: () => ({ ok: true }),
        },
      ],
      argv: ['media', '--output-dir', directory],
      stdin: async () => null,
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
      exit: (value) => {
        code = value;
      },
      resolveAuth: () => ({ apiKey: 'synthetic-profile-credential' }),
      allowPrivateDownloadHosts: true,
      download: () => names.map((name) => ({ url, name })),
      ...config,
    });
  } finally {
    process.umask = originalUmask;
  }
  return { code, err, out };
}
try {
  const directory = join(root, 'downloads');
  await mkdir(directory);
  const outside = join(root, 'outside.txt');
  await writeFile(outside, original);
  if (process.platform === 'win32') {
    const result = await run(directory);
    assert.notEqual(result.code, 0);
    assert.match(result.err, /Linux and macOS/);
    assert.equal(requests, 0);
    assert.deepEqual(await readdir(directory), []);
  } else {
    for (const [name, target] of [
      ['frame.png', outside],
      ['dangling.png', join(root, 'absent.txt')],
    ]) {
      await symlink(target, join(directory, name));
      const result = await run(directory, [name]);
      // Fails first on the published baseline: following the link modifies external bytes.
      assert.deepEqual(await readFile(outside), original);
      assert.equal(result.code, 0, result.err);
      assert.equal((await lstat(join(directory, name))).isSymbolicLink(), false);
      assert.deepEqual(await readFile(join(directory, name)), downloaded);
    }
    await assert.rejects(stat(join(root, 'absent.txt')), { code: 'ENOENT' });
    await link(outside, join(directory, 'hard.png'));
    assert.equal((await run(directory, ['hard.png'])).code, 0);
    assert.deepEqual(await readFile(outside), original);
    assert.deepEqual(await readFile(join(directory, 'hard.png')), downloaded);
    const ordinary = join(directory, 'private.png');
    await writeFile(ordinary, original);
    await chmod(ordinary, 0o600);
    assert.equal((await run(directory, ['private.png'])).code, 0);
    assert.deepEqual(await readFile(ordinary), downloaded);
    assert.equal((await stat(ordinary)).mode & 0o777, 0o600);
    const oldMask = process.umask(0o077);
    try {
      assert.equal((await run(directory, ['new.png'])).code, 0);
      assert.equal((await stat(join(directory, 'new.png'))).mode & 0o777, 0o600);
    } finally {
      process.umask(oldMask);
    }
    await mkdir(join(directory, 'blocked.png'));
    const partial = await run(directory, ['ok.png', 'blocked.png']);
    assert.notEqual(partial.code, 0);
    assert.match(partial.err, /failed to download/);
    assert.deepEqual(JSON.parse(partial.out), { ok: true });
    assert.deepEqual(await readFile(join(directory, 'ok.png')), downloaded);
    assert.ok((await stat(join(directory, 'blocked.png'))).isDirectory());
    assert.deepEqual(
      (await readdir(directory)).filter((name) => name.startsWith('.stitchkit-')),
      [],
    );
    const nested = join(root, 'new', 'nested', 'output');
    assert.equal((await run(nested)).code, 0);
    assert.deepEqual(await readFile(join(nested, 'frame.png')), downloaded);
    const alias = join(root, 'alias');
    await symlink(directory, alias);
    assert.equal((await run(alias, ['alias.png'])).code, 0);
    assert.deepEqual(await readFile(join(directory, 'alias.png')), downloaded);
    // The HTTP response deterministically swaps the root after the batch has pinned it.
    const moved = join(root, 'pinned');
    const hostile = join(root, 'hostile');
    await mkdir(hostile);
    await writeFile(join(hostile, 'race.png'), original);
    let swapped = false;
    requestHook = async () => {
      if (swapped) return;
      swapped = true;
      await rename(directory, moved);
      await symlink(hostile, directory);
    };
    const race = await run(directory, ['race.png', 'second.png']);
    assert.equal(race.code, 0, race.err);
    assert.deepEqual(await readFile(join(hostile, 'race.png')), original);
    await assert.rejects(stat(join(hostile, 'second.png')), { code: 'ENOENT' });
    assert.deepEqual(await readFile(join(moved, 'race.png')), downloaded);
    assert.deepEqual(await readFile(join(moved, 'second.png')), downloaded);
    assert.equal(authorization, undefined);
    requestHook = async () => undefined;
    const beforeGuard = requests;
    const denied = await run(moved, ['denied.png'], { allowPrivateDownloadHosts: false });
    assert.notEqual(denied.code, 0);
    assert.equal(requests, beforeGuard);
    const capped = await run(moved, ['capped.png'], { maxDownloadBytes: 1 });
    assert.notEqual(capped.code, 0);
    await assert.rejects(stat(join(moved, 'capped.png')), { code: 'ENOENT' });
  }
  console.log('packed CLI download containment: ok');
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
