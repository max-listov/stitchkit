import { expect, test } from 'bun:test';
import { type FSWatcher, watch } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchWorktreeInputs, worktreeInputGeneration } from './gate-input-generation';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gate-input-controls-'));
  await mkdir(join(root, 'source'));
  await writeFile(join(root, 'source/a.ts'), 'original');
  await writeFile(join(root, '.gitignore'), 'ignored/\n');
  const child = Bun.spawn(['git', 'init', '--quiet'], { cwd: root });
  expect(await child.exited).toBe(0);
  return root;
}

test('partial watcher setup refusal closes every acquired watcher', async () => {
  const root = await fixture();
  const acquired: FSWatcher[] = [];
  let closed = 0;
  try {
    await expect(
      watchWorktreeInputs(root, (path, listener) => {
        if (acquired.length === 1) throw new Error('controlled setup refusal');
        const watcher = watch(path, listener);
        watcher.on('close', () => {
          closed += 1;
        });
        acquired.push(watcher);
        return watcher;
      }),
    ).rejects.toThrow('controlled setup refusal');
    await Bun.sleep(10);
    expect(acquired).toHaveLength(1);
    expect(closed).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('asynchronous watcher error refuses reusable evidence; stable negative control remains clean', async () => {
  const root = await fixture();
  try {
    const stable = await watchWorktreeInputs(root);
    expect(await stable.finish()).toBe(false);
    const acquired: FSWatcher[] = [];
    const guard = await watchWorktreeInputs(root, (path, listener) => {
      const watcher = watch(path, listener);
      acquired.push(watcher);
      return watcher;
    });
    acquired[0]?.emit('error', new Error('controlled watcher refusal'));
    expect(await guard.finish()).toBe(true);
    expect(await guard.finish()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('symlink generations include ignored target changes, restoration, replacement and dangling identity', async () => {
  const root = await fixture();
  try {
    await mkdir(join(root, 'ignored'));
    const target = join(root, 'ignored/payload');
    await writeFile(target, 'original');
    const link = join(root, 'source/link');
    await symlink(target, link);
    const initial = await worktreeInputGeneration(root);
    expect(await worktreeInputGeneration(root)).toBe(initial);
    await writeFile(target, 'different');
    const drift = await worktreeInputGeneration(root);
    expect(drift).not.toBe(initial);
    await writeFile(target, 'original');
    const restored = await worktreeInputGeneration(root);
    expect(restored).not.toBe(initial);
    await unlink(link);
    await symlink(target, link);
    expect(await worktreeInputGeneration(root)).not.toBe(restored);
    await unlink(target);
    const dangling = await worktreeInputGeneration(root);
    expect(dangling).not.toBe(restored);
    expect(await worktreeInputGeneration(root)).toBe(dangling);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
