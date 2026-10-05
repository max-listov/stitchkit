// A writer killed between staging and publication: the process dies at the fsync of the staged
// bytes, so the staging file a real `writeFileAtomic` / `writeFileAtomicSync` call created is
// left in the directory exactly as a SIGKILL or OOM would leave it.
import { mock } from 'bun:test';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';

const [target, form] = process.argv.slice(2);
if (!target || (form !== 'async' && form !== 'sync'))
  throw new Error('Expected a target path and a form (async | sync)');

function die(): never {
  process.kill(process.pid, 'SIGKILL');
  throw new Error('SIGKILL did not stop the process');
}

const realOpen = fsPromises.open;
mock.module('node:fs/promises', () => ({
  ...fsPromises,
  open: async (...args: Parameters<typeof fsPromises.open>) => {
    const handle = await realOpen(...args);
    if (args[1] === 'wx') handle.sync = async () => die();
    return handle;
  },
}));
mock.module('node:fs', () => ({ ...fs, fsyncSync: () => die() }));

const { writeFileAtomic, writeFileAtomicSync } = await import('../../src/entrypoints/files');
if (form === 'async') await writeFileAtomic(target, 'never published');
else writeFileAtomicSync(target, 'never published');
throw new Error('the write was published');
