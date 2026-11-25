import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { git } from './local-git';
import { withLockfile } from './lockfile-fixture';
import { checkWorkingTree } from './release-plan';
import { pendingStarterFollowUp } from './release-starter-follow-up';
import { readFromCommit, validateReleaseCommit } from './release-validate';

const created: string[] = [];
afterAll(async () => {
  for (const path of created) await rm(path, { recursive: true, force: true });
});

const COMMIT = '-c user.name=T -c user.email=t@e.com commit --no-gpg-sign --quiet -m'.split(
  ' ',
);
const followUpReview = JSON.stringify({
  coreVersion: '0.127.0',
  outcome: 'deferred',
  reason: 'The template cannot build against both cores.',
  followUp: 'create-stitchkit@0.7.0',
});

function changelog(version: string, previous?: string): string {
  const base = `## [${version}] — 2026-11-24\n\n### Added\n\n- Substantive notes for ${version}.\n`;
  return previous
    ? `${base}\n## [${previous}] — 2026-11-20\n\n### Added\n\n- Base release notes.\n`
    : base;
}

/** A repository tree: core, tui and the starter at the given versions; `revision` changes code. */
function tree(core: string, tui: string, starter: string, target: string, revision: number) {
  return withLockfile({
    'packages/core/package.json': `{"name":"stitchkit","version":"${core}"}`,
    'packages/core/src/index.ts': `export const v = ${revision};\n`,
    // The export snapshot `release:check` reads the names of an `**Affects:**` line from.
    'packages/core/tests/fixtures/public-surface.json': '{"stitchkit":["v"]}\n',
    'packages/tui/package.json': `{"name":"stitchkit-tui","version":"${tui}","dependencies":{"stitchkit":"workspace:^"}}`,
    'packages/tui/src/index.ts': `export const t = ${revision};\n`,
    'packages/create-stitchkit/package.json': `{"name":"create-stitchkit","version":"${starter}"}`,
    'packages/create-stitchkit/template/index.ts': `export const s = ${revision};\n`,
    'packages/create-stitchkit/template/package.json': `{"catalog":{"stitchkit":"^${target}"}}`,
    'packages/create-stitchkit/template/bun.lock': `{\n  "packages": {\n    "stitchkit": ["stitchkit@${target}", "", {}, "sha512-x"],\n  }\n}\n`,
    'CHANGELOG.md': changelog(core, core === '0.126.0' ? undefined : '0.126.0'),
    'packages/tui/CHANGELOG.md': changelog(tui, tui === '0.4.7' ? undefined : '0.4.7'),
    'packages/create-stitchkit/CHANGELOG.md': changelog(
      starter,
      starter === '0.6.23' ? undefined : '0.6.23',
    ),
  });
}

function train(...releases: [string, string][]): string {
  return JSON.stringify({
    schemaVersion: 1,
    releases: releases.map(([target, version]) => ({ target, version })),
  });
}

/**
 * Published: core 0.126.0 with starter 0.6.23, then core 0.127.0 (Train 1) whose tag carries a
 * deferral naming create-stitchkit@0.7.0. The working tree is left at Train 1.
 */
async function repositoryAfterTrainOne(): Promise<{
  root: string;
  put: (files: Record<string, string>) => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'starter-follow-up-'));
  created.push(root);
  const put = async (files: Record<string, string>) => {
    for (const [relative, body] of Object.entries(files)) {
      await mkdir(dirname(join(root, relative)), { recursive: true });
      await writeFile(join(root, relative), body);
    }
  };
  await git(root, ['init', '--quiet']);
  await put({
    ...tree('0.126.0', '0.4.7', '0.6.23', '0.126.0', 1),
    'docs/guide/getting-started.md': '| `stitchkit` | both | stable | root |\n',
    'docs/guide/upgrading.md': '# Upgrading\n',
    'packages/tui/UPGRADING.md': '# Upgrading\n',
    'packages/create-stitchkit/UPGRADING.md': '# Upgrading a generated project\n',
  });
  await git(root, ['add', '.']);
  await git(root, [...COMMIT, 'base']);
  for (const tag of ['v0.126.0', 'stitchkit-tui-v0.4.7', 'create-stitchkit-v0.6.23']) {
    await git(root, ['tag', tag]);
  }
  await put({
    ...tree('0.127.0', '0.5.0', '0.6.23', '0.126.0', 2),
    'scripts/starter-head-review.json': followUpReview,
    'release-train.json': train(['core', '0.127.0'], ['tui', '0.5.0']),
  });
  // Train 1 itself is not bound: the newest core tag (0.126.0) promised nothing.
  expect(await pendingStarterFollowUp(root)).toBeUndefined();
  await expect(
    checkWorkingTree(root, { checkStarterLockfile: false }),
  ).resolves.toBeUndefined();
  await git(root, ['add', '.']);
  await git(root, [...COMMIT, 'train one']);
  for (const tag of ['v0.127.0', 'stitchkit-tui-v0.5.0']) await git(root, ['tag', tag]);
  return { root, put };
}

describe('the train after a security deferral is the follow-up starter it named', () => {
  test('release:check accepts the named starter on the deferred core and refuses every other train', async () => {
    const { root, put } = await repositoryAfterTrainOne();
    const check = () => checkWorkingTree(root, { checkStarterLockfile: false });
    expect(await pendingStarterFollowUp(root)).toEqual({
      coreVersion: '0.127.0',
      starterVersion: '0.7.0',
    });

    // Another starter version than the one named.
    await put({
      ...tree('0.127.0', '0.5.0', '0.7.1', '0.127.0', 3),
      'release-train.json': train(['create-stitchkit', '0.7.1']),
    });
    await expect(check()).rejects.toThrow(/named create-stitchkit@0\.7\.0 as the next train/);
    // The pre-push gate judges the commit against the same tags.
    await git(root, ['add', '.']);
    await git(root, [...COMMIT, 'release(train): starter in 0.7.1']);
    const sha = (await git(root, ['rev-parse', 'HEAD'])).trim();
    await expect(
      validateReleaseCommit(
        root,
        { sha, subject: 'release(train): starter in 0.7.1' },
        {
          compareWithPublished: true,
          checkStarterLockfile: false,
          read: readFromCommit(root, sha),
        },
      ),
    ).rejects.toThrow(/named create-stitchkit@0\.7\.0 as the next train/);

    // A core train before the starter.
    await put({
      ...tree('0.127.1', '0.5.0', '0.6.23', '0.126.0', 3),
      'release-train.json': train(['core', '0.127.1']),
    });
    await expect(check()).rejects.toThrow(/named create-stitchkit@0\.7\.0 as the next train/);

    // The named starter, still on the old target: new projects would not get the fix.
    await put({
      ...tree('0.127.0', '0.5.0', '0.7.0', '0.126.0', 3),
      'release-train.json': train(['create-stitchkit', '0.7.0']),
    });
    await expect(check()).rejects.toThrow(/does not allow 0\.127\.0/);

    // Positive control: the named starter on the deferred core, review removed.
    await rm(join(root, 'scripts/starter-head-review.json'));
    await put(tree('0.127.0', '0.5.0', '0.7.0', '0.127.0', 3));
    await expect(check()).resolves.toBeUndefined();

    // Once it is tagged the promise is kept, and the next core train is free again.
    await git(root, ['add', '.']);
    await git(root, [...COMMIT, 'train two']);
    await git(root, ['tag', 'create-stitchkit-v0.7.0']);
    expect(await pendingStarterFollowUp(root)).toBeUndefined();
  });

  test('a clone without core tags is refused, not read as no promise', async () => {
    const root = await mkdtemp(join(tmpdir(), 'starter-follow-up-tagless-'));
    created.push(root);
    await git(root, ['init', '--quiet']);
    await expect(pendingStarterFollowUp(root)).rejects.toThrow(/git fetch origin --tags/);
  });
});
