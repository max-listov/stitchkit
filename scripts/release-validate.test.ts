import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertLockfileWorkspaceVersions, lockedWorkspaceVersion } from './release-lockfile';
import { isReleaseCommitSubject } from './release-subject';
import {
  RELEASE_TARGETS,
  ReleaseTargetSchema,
  ReleaseTrainSchema,
  releasePlanForTag,
  releaseTagForTarget,
  targetForTag,
} from './release-train';
import {
  assertTrainDoesNotOutrunTheStarter,
  releaseCandidateIdentity,
  validateReleaseCommit,
} from './release-validate';

const SHA = '1'.repeat(40);
const BREAKING = '### ⚠️ Breaking changes';

describe('a release commit is checked before it costs a gate', () => {
  const root = resolve(import.meta.dir, '..');

  /** A tree the check reads instead of the repository — one file at a time. */
  // Every tree carries the workspace manifests and a lockfile that agrees with
  // them, unless a test says otherwise: the lockfile gate has its own tests.
  const TRAIN_9_9_0 = JSON.stringify({
    schemaVersion: 1,
    releases: [{ target: 'core', version: '9.9.0' }],
  });
  const WORKSPACES = ['packages/core', 'packages/tui', 'packages/create-stitchkit'];
  const lockFor = (versions: Record<string, string>) =>
    Object.entries(versions)
      .map(
        ([dir, version]) =>
          `    "${dir}": {\n      "name": "x",\n      "version": "${version}",\n    },`,
      )
      .join('\n');
  const treeOf = (given: Record<string, string>) => (relativePath: string) => {
    const files: Record<string, string> = { ...given };
    const versions: Record<string, string> = {};
    for (const dir of WORKSPACES) {
      files[`${dir}/package.json`] ??= JSON.stringify({ version: '0.0.0' });
      versions[dir] = JSON.parse(files[`${dir}/package.json`] ?? '{}').version;
    }
    files['bun.lock'] ??= lockFor(versions);
    files['release-train.json'] ??= TRAIN_9_9_0;
    const contents = files[relativePath];
    if (contents === undefined) {
      return Promise.reject(new Error(`no ${relativePath} in this tree`));
    }
    return Promise.resolve(contents);
  };

  const coreTree = (changelogSection: string, migration: string) =>
    treeOf({
      'packages/core/package.json': JSON.stringify({ version: '9.9.0' }),
      'CHANGELOG.md': ['## [9.9.0] — x', '', changelogSection, ''].join('\n'),
      'docs/guide/upgrading.md': migration,
    });

  const ADDITIVE = ['### Added', '', '- One genuinely new export nobody had before.'].join(
    '\n',
  );
  const BREAKING_NO_AUDIENCE = [
    '### ⚠️ Breaking changes',
    '',
    '- **Something moved**, and this section never says who has to act on it.',
  ].join('\n');
  const RELEASED_MIGRATION = ['## Released migration: 9.9.0', '', 'Do the thing.'].join('\n');

  test('one table names the tag, directory and changelog of every target', () => {
    for (const target of ReleaseTargetSchema.options) {
      const info = RELEASE_TARGETS[target];
      const tag = `${info.tagPrefix}1.2.3`;
      expect(targetForTag(tag)).toEqual({ target, version: '1.2.3' });
      expect(releasePlanForTag(tag)).toEqual({
        target,
        packageName: info.packageName,
        packageDir: info.directory,
        changelog: info.changelog,
        version: '1.2.3',
      });
    }
    expect(releaseTagForTarget('core', '1.2.3')).toBe('v1.2.3');
    expect(releaseTagForTarget('create-stitchkit', '1.2.3')).toBe('create-stitchkit-v1.2.3');
    expect(releaseTagForTarget('tui', '1.2.3')).toBe('stitchkit-tui-v1.2.3');
    expect(targetForTag('other-v1')).toBeUndefined();
    expect(() => releasePlanForTag('other-v1')).toThrow('Unsupported release tag');
    expect(() => releasePlanForTag('v')).toThrow('missing a version');
  });

  test('one candidate identity separates exact-SHA CI from tag publication', () => {
    expect(
      releaseCandidateIdentity(
        {
          target: 'core',
          packageName: 'stitchkit',
          packageDir: 'packages/core',
          changelog: 'CHANGELOG.md',
          version: '9.9.0',
        },
        SHA,
      ),
    ).toEqual({
      schemaVersion: 1,
      target: 'core',
      packageName: 'stitchkit',
      packageDir: 'packages/core',
      changelog: 'CHANGELOG.md',
      version: '9.9.0',
      sha: SHA,
      tag: 'v9.9.0',
      ci: { workflow: 'ci.yml', event: 'push', headSha: SHA },
      publication: { workflow: 'release.yml', event: 'push', tag: 'v9.9.0' },
    });
  });

  test('refuses a breaking section with no audience line — at the COMMIT', async () => {
    // The whole point: this used to be discoverable only when the tag was
    // pushed, which is after the full local gate and a CI run, and after the
    // commit is public. 0.67.0 paid for that with a second release commit.
    await expect(
      validateReleaseCommit(
        root,
        { sha: SHA, subject: 'release(train): a thing in 9.9.0' },
        { read: coreTree(BREAKING_NO_AUDIENCE, RELEASED_MIGRATION) },
      ),
    ).rejects.toThrow(/Who must act/);
  });

  test('refuses a train that names a version the manifest does not carry', async () => {
    await expect(
      validateReleaseCommit(
        root,
        { sha: SHA, subject: 'release(train): a thing in 9.9.1' },
        {
          read: treeOf({
            'packages/core/package.json': JSON.stringify({ version: '9.9.0' }),
            'release-train.json': JSON.stringify({
              schemaVersion: 1,
              releases: [{ target: 'core', version: '9.9.1' }],
            }),
          }),
        },
      ),
    ).rejects.toThrow(/does not match stitchkit package version 9\.9\.0/);
  });

  test('refuses a subject that is not a release commit, and every retired scope', async () => {
    for (const subject of [
      'fix(server): a thing',
      'release(core): a thing in 9.9.0',
      'release(tui): a thing in 9.9.0',
    ]) {
      await expect(
        validateReleaseCommit(
          root,
          { sha: SHA, subject },
          { read: coreTree(ADDITIVE, RELEASED_MIGRATION) },
        ),
      ).rejects.toThrow(/not a release commit subject/);
    }
  });

  test('a commit that carries more than release metadata, or nothing, is refused', async () => {
    const options = { read: coreTree(ADDITIVE, RELEASED_MIGRATION) };
    const commit = { sha: SHA, subject: 'release(train): a thing in 9.9.0' };
    await expect(
      validateReleaseCommit(root, commit, {
        ...options,
        changedFiles: async () => ['CHANGELOG.md', 'packages/core/src/server/handler.ts'],
      }),
    ).rejects.toThrow(/more than release metadata/);
    await expect(
      validateReleaseCommit(root, commit, { ...options, changedFiles: async () => [] }),
    ).rejects.toThrow(/is empty/);
    await expect(
      validateReleaseCommit(root, commit, {
        ...options,
        changedFiles: async () => ['CHANGELOG.md', 'release-train.json', 'bun.lock'],
      }),
    ).resolves.toMatchObject({ version: '9.9.0' });
  });

  test('accepts a well-formed additive release commit', async () => {
    const validated = await validateReleaseCommit(
      root,
      { sha: SHA, subject: 'release(train): a thing in 9.9.0' },
      { read: coreTree(ADDITIVE, RELEASED_MIGRATION) },
    );
    expect(validated.version).toBe('9.9.0');
    expect(validated.packageName).toBe('stitchkit');
  });

  describe('breaking metadata validation preserves disclosure without a calendar limit — ADR 0204', () => {
    const GUIDE = [
      '| Import | Use in | Maturity | Holds |',
      '|--------|--------|----------|-------|',
      '| `stitchkit/tools` | server | stable | tools |',
      '| `stitchkit/live` | browser **and** server | evolving | watched reads |',
    ].join('\n');
    const MIGRATION = ['## Released migration: 9.9.0', '', 'Do the thing.'].join('\n');
    const breaking = (entry: string) =>
      [BREAKING, '', entry, '', '**Who must act:** anyone calling it.'].join('\n');
    const STABLE_ENTRY = [
      '- `stitchkit/tools` — **a tool moved**, because a reason. → ADR 0198',
      '  **Affects:** `stitchkit/tools` mountAgent(lifecycle)',
    ].join('\n');
    const tree = (changelog: string) =>
      treeOf({
        'packages/core/package.json': JSON.stringify({
          version: '9.9.0',
          exports: { './tools': {} },
        }),
        'CHANGELOG.md': changelog,
        'docs/guide/upgrading.md': MIGRATION,
        'docs/guide/getting-started.md': GUIDE,
      });
    const commit = { sha: SHA, subject: 'release(train): a thing in 9.9.0' };

    test('one stable-breaking minor in the week passes', async () => {
      const changelog = [
        '## [9.9.0] — 2026-10-20',
        '',
        breaking(STABLE_ENTRY),
        '',
        '## [9.8.0] — 2026-10-12',
        '',
        breaking(STABLE_ENTRY),
      ].join('\n');
      const validated = await validateReleaseCommit(root, commit, { read: tree(changelog) });
      expect(validated.version).toBe('9.9.0');
    });

    test('a second stable-breaking minor within seven days passes metadata validation', async () => {
      const changelog = [
        '## [9.9.0] — 2026-10-18',
        '',
        breaking(STABLE_ENTRY),
        '',
        '## [9.8.0] — 2026-10-12',
        '',
        breaking(STABLE_ENTRY),
      ].join('\n');
      await expect(
        validateReleaseCommit(root, commit, { read: tree(changelog) }),
      ).resolves.toMatchObject({ target: 'core', version: '9.9.0' });
    });

    test('an entry that does not lead with its entrypoint is refused', async () => {
      const changelog = [
        '## [9.9.0] — 2026-10-18',
        '',
        breaking('- **Something moved**'),
      ].join('\n');
      await expect(
        validateReleaseCommit(root, commit, { read: tree(changelog) }),
      ).rejects.toThrow(/does not start with the entrypoint/);
    });
  });

  describe('every breaking item names what it touches', () => {
    const tree = (item: string) =>
      treeOf({
        'packages/core/package.json': JSON.stringify({
          version: '9.9.0',
          exports: { '.': {}, './live': {} },
        }),
        'CHANGELOG.md': [
          '## [9.9.0] — 2026-10-20',
          '',
          BREAKING,
          '',
          '**Who must act:** callers of the moved thing.',
          '',
          item,
        ].join('\n'),
        'docs/guide/upgrading.md': ['## Released migration: 9.9.0', '', 'Do it.'].join('\n'),
        'docs/guide/getting-started.md':
          '| `stitchkit/live` | browser **and** server | evolving | watched reads |',
      });
    const commit = { sha: SHA, subject: 'release(train): a thing in 9.9.0' };
    const entry = '- `stitchkit/live` — **a read moved**, because a reason.';

    test('an item without an Affects line is refused, naming the item', async () => {
      await expect(validateReleaseCommit(root, commit, { read: tree(entry) })).rejects.toThrow(
        /9\.9\.0: breaking item "- `stitchkit\/live` — \*\*a read moved\*\*, because a reason\." has no "\*\*Affects:\*\*" line/,
      );
    });

    test('a malformed Affects line is refused with the part that is wrong', async () => {
      await expect(
        validateReleaseCommit(root, commit, {
          read: tree(`${entry}\n  **Affects:** createLiveState`),
        }),
      ).rejects.toThrow(
        /malformed "\*\*Affects:\*\*" line: "createLiveState" does not start with/,
      );
    });

    test('a star or plus bullet still needs its line, and a section without items is refused', async () => {
      await expect(
        validateReleaseCommit(root, commit, { read: tree(entry.replace(/^- /, '* ')) }),
      ).rejects.toThrow(/has no "\*\*Affects:\*\*" line/);
      await expect(
        validateReleaseCommit(root, commit, { read: tree(entry.replace(/^- /, '+ ')) }),
      ).rejects.toThrow(/has no "\*\*Affects:\*\*" line/);
      await expect(
        validateReleaseCommit(root, commit, {
          read: tree('The live read moved, because a reason.'),
        }),
      ).rejects.toThrow(/section has no items/);
    });

    test('two Affects lines are refused, not reduced to the first', async () => {
      await expect(
        validateReleaseCommit(root, commit, {
          read: tree(
            `${entry}\n  **Affects:** \`stitchkit/live\` createLiveState\n  **Affects:** \`stitchkit\` ApiError`,
          ),
        }),
      ).rejects.toThrow(/carries 2 "\*\*Affects:\*\*" lines/);
    });

    test('an entrypoint the package does not export is refused unless it is removed (*)', async () => {
      await expect(
        validateReleaseCommit(root, commit, {
          read: tree(`${entry}\n  **Affects:** \`stitchkit/lvie\` createLiveState`),
        }),
      ).rejects.toThrow(
        /names `stitchkit\/lvie` in its "\*\*Affects:\*\*" line, which packages\/core\/package.json does not export/,
      );
      await expect(
        validateReleaseCommit(root, commit, {
          read: tree(`${entry}\n  **Affects:** \`stitchkit/lvie\` behaviour`),
        }),
      ).rejects.toThrow(/does not export/);
    });

    test('names, behaviour and a removed leaf are each accepted', async () => {
      for (const line of [
        '`stitchkit/live` createLiveState(maxSubscribers), LiveStateSnapshot',
        '`stitchkit/live` behaviour',
        '`stitchkit/live-old` *',
        '`stitchkit/live`, `stitchkit` createLiveState; `stitchkit/live` behaviour',
      ]) {
        await expect(
          validateReleaseCommit(root, commit, {
            read: tree(`${entry}\n  **Affects:** ${line}`),
          }),
        ).resolves.toMatchObject({ version: '9.9.0' });
      }
    });
  });

  test('the release commit this repository last made passes it', async () => {
    // Not a synthetic tree: the real one, read out of the real commit. Skipped
    // rather than silently passed when HEAD is an ordinary commit — a test that
    // returns early looks exactly like a test that checked something.
    const subject = (await Bun.$`git log -1 --format=%s HEAD`.text()).trim();
    if (!isReleaseCommitSubject(subject)) {
      expect(isReleaseCommitSubject(subject)).toBe(false);
      return;
    }
    const sha = (await Bun.$`git rev-parse HEAD`.text()).trim();
    // A historical release commit must keep validating after newer versions
    // appear on npm. Its mutable registry gate was answered before tagging;
    // this assertion checks the immutable metadata carried by the commit.
    const validated = await validateReleaseCommit(
      root,
      { sha, subject },
      { checkStarterLockfile: false },
    );
    const manifest: unknown = JSON.parse(
      await Bun.$`git show ${sha}:${validated.packageDir}/package.json`.text(),
    );
    expect(validated.version).toBe(
      typeof manifest === 'object' && manifest !== null
        ? Reflect.get(manifest, 'version')
        : null,
    );
  });
});

describe('a train cannot publish the framework its own starter must pin', () => {
  const root = resolve(import.meta.dir, '..');

  const starterTree = (range: string) => (relativePath: string) => {
    if (relativePath.endsWith('template/package.json')) {
      return Promise.resolve(JSON.stringify({ catalog: { stitchkit: range } }));
    }
    if (relativePath.endsWith('template/bun.lock')) {
      return Promise.resolve(
        '{ "packages": { "stitchkit": ["stitchkit@0.90.5", "", {}, "x"] } }',
      );
    }
    return Promise.reject(new Error(`no ${relativePath} in this tree`));
  };

  const train = (releases: { target: string; version: string }[]) =>
    ReleaseTrainSchema.parse({ schemaVersion: 1, releases });

  test('the exact 0.6.1 train is refused, and the refusal names both versions', async () => {
    await expect(
      assertTrainDoesNotOutrunTheStarter(
        root,
        train([
          { target: 'core', version: '0.90.6' },
          { target: 'create-stitchkit', version: '0.6.1' },
        ]),
        starterTree('^0.90.5'),
      ),
    ).rejects.toThrow(/publishes stitchkit 0\.90\.6 and create-stitchkit 0\.6\.1 together/);
  });

  test('a starter targeting an older minor rides along with a new one', async () => {
    // The narrow case the refusal must not swallow: the framework the train
    // publishes is outside the starter's range, so its lockfile owes it nothing.
    await expect(
      assertTrainDoesNotOutrunTheStarter(
        root,
        train([
          { target: 'core', version: '0.91.0' },
          { target: 'create-stitchkit', version: '0.6.2' },
        ]),
        starterTree('^0.90.5'),
      ),
    ).resolves.toBeUndefined();
  });

  test('a train without one of the two halves is not this question', async () => {
    for (const releases of [
      [{ target: 'core', version: '0.90.7' }],
      [{ target: 'create-stitchkit', version: '0.6.2' }],
      [
        { target: 'core', version: '0.90.7' },
        { target: 'tui', version: '0.1.3' },
      ],
    ]) {
      await expect(
        assertTrainDoesNotOutrunTheStarter(root, train(releases), starterTree('^0.90.5')),
      ).resolves.toBeUndefined();
    }
  });
});

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
