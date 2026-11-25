import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reapAfterEachTest, trackProcess } from './support/process-reaper';

reapAfterEachTest();

const fixture = fileURLToPath(
  new URL('./fixtures/artifact-activation-durability.ts', import.meta.url),
);

test('activation puts every release file and directory on the device before current names it', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'artifact-durability-'));
  try {
    // The fixture replaces `node:fs/promises` to record fsync and rename: its own process.
    const child = Bun.spawn([process.execPath, fixture, root], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    trackProcess(child.pid);
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exit !== 0) throw new Error(`fixture exited ${exit}: ${stderr}`);
    expect(JSON.parse(stdout)).toEqual([
      'sync .',
      'sync releases/<staged>/manifest.json',
      'sync releases/<staged>/bin/app',
      'sync releases/<staged>/lib/deep/data.json',
      'sync releases/<staged>/lib/deep',
      'sync releases/<staged>/bin',
      'sync releases/<staged>/lib',
      'sync releases/<staged>',
      'rename releases/v1',
      'sync releases',
      'rename current',
      'sync .',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
