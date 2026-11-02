import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { refuseWriteConflict } from '../src/agent-runtime/coding-tool-refusals';
import { openContainedParent } from '../src/internal/contained-files';
import { runNativeCommand } from '../src/process/command';
import { reapAfterEachTest, trackGroupLeader } from './support/process-reaper';

reapAfterEachTest();
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')(
  'every entry control of the installed proof holds on source, in a child a blocked open cannot hang',
  async () => {
    const result = await runNativeCommand({
      executable: process.execPath,
      args: [fileURLToPath(new URL('./support/contained-entry-probe.ts', import.meta.url))],
      envPolicy: 'ambient',
      capture: true,
      timeoutMs: 5_000,
      maxOutputBytes: 32 * 1024,
      onLeaderStarted: trackGroupLeader,
    });
    expect(new TextDecoder().decode(result.stderr)).toBe('');
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toContain(
      'packed contained entry boundaries: ok',
    );
  },
  8_000,
);

test('shared parent traversal refuses NUL in the leaf and ancestors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stitchkit-entry-boundary-'));
  roots.push(root);
  for (const path of ['secret\0allowed', 'directory\0allowed/file']) {
    await expect(openContainedParent(root, path)).rejects.toThrow('invalid segments');
  }
  expect(await readdir(root)).toEqual([]);
});

test('a lost race and a symlink are named; a host-level cause stays the original failure', () => {
  expect(() =>
    refuseWriteConflict(Object.assign(new Error('raced'), { code: 'EEXIST' }), 'file'),
  ).toThrow('This file already exists');
  expect(() =>
    refuseWriteConflict(Object.assign(new Error('link'), { code: 'ELOOP' }), 'file'),
  ).toThrow('This path is a symlink');
  for (const code of ['ENOSPC', 'EACCES']) {
    const hostFailure = Object.assign(new Error(code), { code });
    expect(() => refuseWriteConflict(hostFailure, 'file')).toThrow(hostFailure);
  }
});
