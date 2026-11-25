import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  assertLockfileMatchesManifests,
  assertLockfileWorkspaceVersions,
  lockedWorkspaceVersion,
  lockfileManifestDrift,
  WORKSPACE_PACKAGE_DIRS,
  workspaceManifests,
} from './release-lockfile';

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

describe('the lockfile records what the manifests declare', () => {
  const lock = (entry: string) =>
    `{\n  "lockfileVersion": 1,\n  "workspaces": {\n    "packages/core": {\n      "name": "stitchkit",\n      "version": "0.1.0",\n${entry}\n    },\n  },\n}\n`;
  const recorded = lock(
    '      "peerDependencies": {\n        "ai": "^7.0.0",\n      },\n      "optionalPeers": [\n        "ai",\n      ],',
  );
  const manifest = (fields: Record<string, unknown>) =>
    JSON.stringify({ name: 'stitchkit', version: '0.1.0', ...fields });

  test('a peer the manifest gained and the lock never wrote is drift; the same peer recorded is not', () => {
    const withPeer = manifest({
      peerDependencies: { ai: '^7.0.0', sdk: '^0.3.0' },
      peerDependenciesMeta: { ai: { optional: true }, sdk: { optional: true } },
    });
    expect(lockfileManifestDrift(recorded, { 'packages/core': withPeer })).toEqual([
      'packages/core peerDependencies sdk: package.json "^0.3.0", bun.lock null',
      'packages/core optionalPeers: package.json ["ai","sdk"], bun.lock ["ai"]',
    ]);
    const same = manifest({
      peerDependencies: { ai: '^7.0.0' },
      peerDependenciesMeta: { ai: { optional: true } },
    });
    expect(lockfileManifestDrift(recorded, { 'packages/core': same })).toEqual([]);
    expect(() =>
      assertLockfileMatchesManifests(recorded, { 'packages/core': withPeer }),
    ).toThrow(/bun install --lockfile-only/);
  });

  test("this repository's bun.lock records every dependency its workspace manifests declare, the root's too", async () => {
    const root = `${import.meta.dir}/..`;
    const read = (path: string) => Bun.file(`${root}/${path}`).text();
    const manifests = await workspaceManifests(read);
    expect(Object.keys(manifests)).toEqual(['', ...WORKSPACE_PACKAGE_DIRS]);
    expect(lockfileManifestDrift(await read('bun.lock'), manifests)).toEqual([]);
    // The root is a workspace like any other: a devDependency the lock never wrote is drift.
    const rootManifest = z
      .object({ devDependencies: z.record(z.string(), z.string()) })
      .loose()
      .parse(JSON.parse(manifests[''] ?? '{}'));
    const grown = {
      ...manifests,
      '': JSON.stringify({
        ...rootManifest,
        devDependencies: { ...rootManifest.devDependencies, 'left-pad': '^1.3.0' },
      }),
    };
    expect(lockfileManifestDrift(await read('bun.lock'), grown)).toEqual([
      ' devDependencies left-pad: package.json "^1.3.0", bun.lock null',
    ]);
  });
});
