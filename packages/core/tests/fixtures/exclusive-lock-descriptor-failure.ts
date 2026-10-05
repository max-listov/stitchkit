// A lock file whose descriptor refuses `chmod`: the failure keeps its cause and no lock name is published.
import { mock } from 'bun:test';
import * as fs from 'node:fs/promises';

const [root] = process.argv.slice(2);
if (!root) throw new Error('Expected a scratch directory');
const failure = new Error('descriptor mode failed');
const realOpen = fs.open;
mock.module('node:fs/promises', () => ({
  ...fs,
  open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await realOpen(...args);
    if (String(args[0]).startsWith(root) && args[1] === 'wx')
      handle.chmod = async () => {
        throw failure;
      };
    return handle;
  },
}));
const { withExclusiveLock } = await import('../../src/entrypoints/files');
try {
  await withExclusiveLock(`${root}/lock`, () => {
    throw new Error('callback must not run');
  });
  throw new Error('must fail');
} catch (error) {
  if (error !== failure) throw error;
}
if ((await fs.readdir(root)).length !== 0)
  throw new Error('a file survived the failed create');
console.log('descriptor failure: ok');
