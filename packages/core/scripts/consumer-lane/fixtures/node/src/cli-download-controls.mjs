import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCli } from 'stitchkit/cli';
import { z } from 'zod';
import { listenFetchable } from './listen-fetchable.mjs';

/** The public CLI path in packed, relocated and embedded Darwin artifacts. */
export async function cliDownloadControls(unavailable = false) {
  const root = await mkdtemp(join(tmpdir(), 'sk-artifact-download-'));
  const server = createServer((_request, response) => response.end(Buffer.from([0, 255, 42])));
  await listenFetchable(server);
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const directory = join(root, 'downloads');
    await mkdir(directory);
    const outside = join(root, 'outside');
    await writeFile(outside, 'untouched');
    await symlink(outside, join(directory, 'frame.png'));
    let code = -1;
    let error = '';
    await createCli({
      name: 'artifact-download',
      version: '1',
      runtimeTools: [
        {
          name: 'media',
          description: 'Download a synthetic file',
          identity: { serviceName: 'media', action: 'get', method: 'GET' },
          transports: ['CLI'],
          input: z.object({}),
          output: z.object({ ok: z.boolean() }),
          handler: () => ({ ok: true }),
        },
      ],
      argv: ['media', '--output-dir', directory],
      stdin: async () => null,
      stdout: () => undefined,
      stderr: (text) => {
        error += text;
      },
      exit: (value) => {
        code = value;
      },
      allowPrivateDownloadHosts: true,
      download: () => [{ url: `http://127.0.0.1:${address.port}/media`, name: 'frame.png' }],
    });
    assert.equal(await readFile(outside, 'utf8'), 'untouched');
    assert.deepEqual(await readdir(directory), ['frame.png']);
    if (unavailable) {
      assert.notEqual(code, 0);
      assert.match(error, /Darwin backend/);
      assert.equal(await readFile(join(directory, 'frame.png'), 'utf8'), 'untouched');
    } else {
      assert.equal(code, 0, error);
      assert.deepEqual(
        await readFile(join(directory, 'frame.png')),
        Buffer.from([0, 255, 42]),
      );
    }
    console.log(`Darwin artifact CLI download: ${unavailable ? 'refused' : 'ok'}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}
