import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNativeCommand } from '../src/entrypoints/process';
import { createMcpHandler } from '../src/entrypoints/tools/mcp';
import { createManagedFileBoundary } from '../src/files/boundary';
import { defineViewFileTool } from '../src/tools/transfer/define-view-file-tool';
import { AUDIO_BYTES, IMAGE_BYTES, savedLink } from './support/cli-media';
import { reapAfterEachTest, trackGroupLeader } from './support/process-reaper';

reapAfterEachTest();
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sk-cli-inline-mcp-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test('a process CLI saves defineViewFileTool media under their source names through a real MCP connection', async () => {
  await writeFile(join(root, 'picture.png'), IMAGE_BYTES);
  await writeFile(join(root, 'voice.ogg'), AUDIO_BYTES);
  const files = await createManagedFileBoundary({ root });
  const handler = createMcpHandler({
    serverInfo: { name: 'media', version: '1' },
    auth: () => ({}),
    context: () => ({}),
    services: [],
    runtimeTools: [
      defineViewFileTool({
        description: 'Inspect protected synthetic media',
        identity: { serviceName: 'media', action: 'view' },
        transports: ['MCP'],
        files,
      }),
    ],
  });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req) => handler.fetch(req),
  });
  const output = join(root, 'output');
  try {
    const result = await runNativeCommand({
      executable: process.execPath,
      args: [
        `${import.meta.dir}/fixtures/cli-json-mcp.ts`,
        `http://127.0.0.1:${server.port}/mcp`,
        'view_file',
        `--paths:=${JSON.stringify(['picture.png', 'voice.ogg'])}`,
        '--output-dir',
        output,
        '--json',
      ],
      timeoutMs: 10_000,
      capture: true,
      maxOutputBytes: 8192,
      onLeaderStarted: trackGroupLeader,
    });
    const out = new TextDecoder().decode(result.stdout);
    const err = new TextDecoder().decode(result.stderr);
    expect({ exit: result.exitCode, signal: result.signal, err }).toEqual({
      exit: 0,
      signal: null,
      err: expect.stringContaining('saved '),
    });
    // The names crossed the MCP connection inside the media blocks.
    expect((await readdir(output)).sort()).toEqual(['picture.png', 'voice.ogg']);
    expect(new Uint8Array(await readFile(join(output, 'picture.png')))).toEqual(IMAGE_BYTES);
    expect(new Uint8Array(await readFile(join(output, 'voice.ogg')))).toEqual(AUDIO_BYTES);
    expect(err.match(/^saved /gm)).toHaveLength(2);
    // Stdout carries a link to each saved file and none of their bytes.
    expect(JSON.parse(out).content).toEqual([
      savedLink(output, 'picture.png', 'image/png', IMAGE_BYTES.length),
      { type: 'text', text: '[image] image/png, 0KB' },
      savedLink(output, 'voice.ogg', 'audio/ogg', AUDIO_BYTES.length),
      { type: 'text', text: '[audio] audio/ogg, 0KB' },
    ]);
  } finally {
    await server.stop(true);
    await handler.close();
  }
});
