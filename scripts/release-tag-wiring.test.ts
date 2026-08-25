import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateReleaseTag } from './release-plan';
import type { FetchLike } from './starter-lockfile';

/**
 * The gate is attached to the right channel — checked at the point of
 * attachment, not only in pieces.
 *
 * `assertLockfileResolvesNewest` has ten unit tests and every one of them would
 * still pass if the call had been wired into the wrong branch, or into none at
 * all. What those tests cannot see is the wiring itself, and the wiring carries
 * two claims that matter:
 *
 * - a **starter** tag reaches the registry, so a lockfile behind its own range
 *   refuses the release;
 * - a **core** tag does NOT, so publishing the framework never depends on a
 *   question about the scaffolder — nor on the network being up.
 *
 * The registry is injected, so both claims are proved without one.
 */

const created: string[] = [];
afterAll(async () => {
  for (const path of created) await rm(path, { recursive: true, force: true });
});

interface TreeOptions {
  coreVersion: string;
  starterVersion: string;
  /** The template's `catalog.stitchkit`. */
  range: string;
  /** What `template/bun.lock` resolves `stitchkit` to. */
  locked: string;
}

async function releaseTree(options: TreeOptions): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'release-wiring-'));
  created.push(root);

  const notes = (version: string) =>
    `# Changelog\n\n## [${version}]\n\n### Added\n\n- Something substantive enough to pass the notes gate.\n`;

  const files: Record<string, string> = {
    'CHANGELOG.md': notes(options.coreVersion),
    'docs/guide/upgrading.md': '# Upgrading\n',
    'packages/core/package.json': JSON.stringify({ version: options.coreVersion }),
    'packages/create-stitchkit/package.json': JSON.stringify({
      version: options.starterVersion,
    }),
    'packages/create-stitchkit/CHANGELOG.md': notes(options.starterVersion),
    'packages/create-stitchkit/UPGRADING.md': '# Upgrading a generated project\n',
    'packages/create-stitchkit/template/package.json': JSON.stringify({
      catalog: { stitchkit: options.range },
    }),
    'packages/create-stitchkit/template/bun.lock': `{\n  "packages": {\n    "stitchkit": ["stitchkit@${options.locked}", "", {}, "sha512-x"],\n  }\n}\n`,
  };
  for (const [relative, contents] of Object.entries(files)) {
    const path = join(root, relative);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, contents);
  }
  return root;
}

/** A registry that records whether it was consulted at all. */
function registry(versions: string[]): { fetch: FetchLike; calls: () => number } {
  let calls = 0;
  const answer: FetchLike = () => {
    calls += 1;
    return Promise.resolve(
      Response.json({ versions: Object.fromEntries(versions.map((v) => [v, {}])) }),
    );
  };
  return { fetch: answer, calls: () => calls };
}

const CURRENT: TreeOptions = {
  coreVersion: '0.60.1',
  starterVersion: '0.4.2',
  range: '^0.60.1',
  locked: '0.60.1',
};

describe('the starter lockfile gate is attached to the starter channel', () => {
  test('a starter tag consults the registry and passes when the lockfile is current', async () => {
    const npm = registry(['0.60.0', '0.60.1']);
    const root = await releaseTree(CURRENT);
    const plan = await validateReleaseTag(root, 'create-stitchkit-v0.4.2', {
      fetch: npm.fetch,
    });
    expect(plan.target).toBe('create-stitchkit');
    expect(npm.calls()).toBe(1);
  });

  test('a starter tag with a stale lockfile is refused — the exact 0.4.1 shape', async () => {
    const npm = registry(['0.60.0', '0.60.1']);
    const root = await releaseTree({ ...CURRENT, range: '^0.60.0', locked: '0.60.0' });
    await expect(
      validateReleaseTag(root, 'create-stitchkit-v0.4.2', { fetch: npm.fetch }),
    ).rejects.toThrow(/would install 0\.60\.0/);
  });

  test('a core tag never touches the registry', async () => {
    // Not a nicety. A framework release must not be able to fail on a question
    // about the scaffolder, and it must not need the network to answer one.
    const npm = registry(['0.60.0', '0.60.1']);
    const root = await releaseTree({ ...CURRENT, range: '^0.60.0', locked: '0.60.0' });
    const plan = await validateReleaseTag(root, 'v0.60.1', { fetch: npm.fetch });
    expect(plan.target).toBe('core');
    // The same tree that refuses a starter tag above passes a core tag here,
    // which is the whole point: the stale lockfile is not the framework's
    // business.
    expect(npm.calls()).toBe(0);
  });

  test('an unreachable registry refuses a starter tag rather than passing it', async () => {
    const offline: FetchLike = () => Promise.reject(new Error('getaddrinfo ENOTFOUND'));
    const root = await releaseTree(CURRENT);
    await expect(
      validateReleaseTag(root, 'create-stitchkit-v0.4.2', { fetch: offline }),
    ).rejects.toThrow(/refuses rather than passing/);
  });

  test('the default is the real fetch — the injection is a seam, not a stub', async () => {
    // Without this the tests above prove only that an injected function gets
    // called; they say nothing about what runs when nobody injects anything.
    //
    // Proved by swapping the global rather than by reaching the network. A unit
    // suite that talks to npm is two defects at once: it fails offline, and it
    // fails on the day the next patch publishes — this fixture's range would
    // then allow a version its lockfile does not pin, which is exactly what the
    // gate refuses. `bun run test` sits inside the fast profile and inside CI,
    // so that failure would turn master red for a reason unrelated to the
    // change being pushed, and would do it first on a release commit.
    const original = globalThis.fetch;
    let asked = '';
    globalThis.fetch = ((input: string) => {
      asked = String(input);
      return Promise.resolve(Response.json({ versions: { '0.60.1': {} } }));
    }) as typeof globalThis.fetch;
    try {
      const root = await releaseTree(CURRENT);
      const plan = await validateReleaseTag(root, 'create-stitchkit-v0.4.2');
      expect(plan.version).toBe('0.4.2');
      // The default really resolved to the global, and asked the registry for
      // the right package.
      expect(asked).toBe('https://registry.npmjs.org/stitchkit');
    } finally {
      globalThis.fetch = original;
    }
  });
});
