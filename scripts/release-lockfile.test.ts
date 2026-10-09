import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertLockfileWorkspaceVersions, lockedWorkspaceVersion } from './release-lockfile';

describe('the lockfile names the versions the manifests carry', () => {
  // `bun pm pack` writes `workspace:^` from bun.lock, not from package.json:
  // stitchkit-tui 0.1.3 shipped depending on `stitchkit ^0.93.0` beside 0.94.0.
  const lock = [
    '    "packages/core": {',
    '      "name": "stitchkit",',
    '      "version": "0.94.0",',
    '      "bin": {',
    '        "stitchkit": "./dist/bin.js",',
    '      },',
    '    },',
    '    "packages/tui": {',
    '      "name": "stitchkit-tui",',
    '      "version": "0.1.3",',
    '    },',
  ].join('\n');

  test('reads the version each workspace entry records', () => {
    expect(lockedWorkspaceVersion(lock, 'packages/core')).toBe('0.94.0');
    expect(lockedWorkspaceVersion(lock, 'packages/tui')).toBe('0.1.3');
    expect(lockedWorkspaceVersion(lock, 'packages/create-stitchkit')).toBeNull();
  });

  test('accepts a lockfile that agrees and refuses one a bump left behind', () => {
    expect(() =>
      assertLockfileWorkspaceVersions(lock, {
        'packages/core': '0.94.0',
        'packages/tui': '0.1.3',
      }),
    ).not.toThrow();
    expect(() =>
      assertLockfileWorkspaceVersions(lock, {
        'packages/core': '0.95.0',
        'packages/tui': '0.1.3',
      }),
    ).toThrow('packages/core: bun.lock 0.94.0, package.json 0.95.0');
  });

  test("this repository's lockfile agrees with its manifests", () => {
    const root = resolve(import.meta.dir, '..');
    const manifests = Object.fromEntries(
      ['packages/core', 'packages/tui', 'packages/create-stitchkit'].map((dir) => [
        dir,
        JSON.parse(readFileSync(`${root}/${dir}/package.json`, 'utf8')).version,
      ]),
    );
    expect(() =>
      assertLockfileWorkspaceVersions(readFileSync(`${root}/bun.lock`, 'utf8'), manifests),
    ).not.toThrow();
  });
});
