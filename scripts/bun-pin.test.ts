import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertPinnedBun, bunPins, pinnedBun } from './bun-pin';

const root = join(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('one Bun version for CI, the starter and every gate', () => {
  test('every workflow and manifest pin names the same version', () => {
    expect(bunPins(read).length).toBeGreaterThan(8);
    expect(pinnedBun(read)).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('a single drifting pin is refused by name', () => {
    const drifted = (path: string) =>
      path === 'packages/tui/package.json'
        ? read(path).replace(/"packageManager": "bun@[^"]+"/, '"packageManager": "bun@0.0.1"')
        : read(path);
    expect(() => pinnedBun(drifted)).toThrow('packages/tui/package.json: 0.0.1');
  });

  test('a gate runs on the pinned Bun, so its green answers for CI', () => {
    const pinned = pinnedBun(read);
    expect(() => assertPinnedBun(root, '0.0.1')).toThrow(`CI runs Bun ${pinned}`);
    assertPinnedBun(root);
  });
});
