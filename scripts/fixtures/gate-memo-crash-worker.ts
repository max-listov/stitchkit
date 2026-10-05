// A writer that stalls after its staged bytes landed and before they are published; the parent kills it.
import { mock } from 'bun:test';
import * as fs from 'node:fs/promises';

const [path] = Bun.argv.slice(2);
if (!path) throw new Error('Expected a memo path');
const actualOpen = fs.open;
// Whichever method writes the staged bytes publishes nothing: it stalls after the bytes land.
const stalls = new Set(['write', 'writeFile']);
mock.module('node:fs/promises', () => ({
  ...fs,
  open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await actualOpen(...args);
    // The staging file of an atomic write is a hidden `.stitchkit-<random>.tmp` beside the target.
    if (!/\/\.stitchkit-[0-9a-f]+\.tmp$/.test(String(args[0]))) return handle;
    return new Proxy(handle, {
      get(target, property) {
        const member = Reflect.get(target, property);
        if (typeof member !== 'function') return member;
        if (!stalls.has(String(property))) return member.bind(target);
        return async (...data: unknown[]) => {
          await member.apply(target, data);
          console.log('ready');
          await new Promise(() => undefined);
        };
      },
    });
  },
}));
const { writeGreenGate } = await import('../gate-memo');
const record = { tree: 'one', toolchain: 'bun:test', at: 'now', commit: '(no commit)' };
await writeGreenGate('crashed', record, path);
