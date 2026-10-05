// Guard removal is paused while a competing writer arrives: the competitor must wait for the guard owner.
import { mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import { until } from '../support/until';

const root = await fs.mkdtemp('/tmp/stitchkit-guard-pause-');
const path = `${root}/lock`;
const guard = `${path}.reclaim`;
const realUnlink = fs.unlink;
const realOpen = fs.open;
// Paths the competing writer tried to open after the guard owner paused.
const opened: string[] = [];
let paused = false;
let entered = false;
const waiting = Promise.withResolvers<void>();
const held = Promise.withResolvers<void>();
mock.module('node:fs/promises', () => ({
  ...fs,
  open: async (...args: Parameters<typeof fs.open>) => {
    if (paused) opened.push(String(args[0]));
    return realOpen(...args);
  },
  unlink: async (name: string) => {
    if (name === guard && !paused) {
      paused = true;
      waiting.resolve();
      await held.promise;
    }
    return realUnlink(name);
  },
}));
const { withExclusiveLock } = await import('../../src/entrypoints/files');
const options = { machineIdentity: 'fixture', timeoutMs: 2000 };
let first: Promise<void> | undefined;
let second: Promise<void> | undefined;
try {
  const owner = await withExclusiveLock(`${root}/known`, (lock) => lock.owner, options);
  if (!owner.process) throw new Error('native lifetime missing');
  const stale = JSON.stringify({
    ...owner,
    process: { ...owner.process, bootId: 'previous-boot' },
  });
  await fs.writeFile(path, stale);
  await fs.writeFile(guard, stale);
  first = withExclusiveLock(path, () => undefined, options);
  await waiting.promise;
  second = withExclusiveLock(
    path,
    () => {
      entered = true;
    },
    options,
  );
  // The competitor has reached the guard of the guard and was refused there.
  await until(() => opened.includes(`${guard}.reclaim`), 'the competitor to reach the guard');
  if (entered) throw new Error('competing writer bypassed paused guard recovery');
  held.resolve();
  await Promise.all([first, second]);
  if (!entered) throw new Error('second writer never acquired');
  console.log('serialized guard recovery: ok');
} finally {
  held.resolve();
  await Promise.allSettled([first, second]);
  await fs.rm(root, { recursive: true, force: true });
}
