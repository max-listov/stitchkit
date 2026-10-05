import { describe, expect, test } from 'bun:test';
import { askReleaseCi, selectSuccessfulCiRun } from './release-ci';
import { assertMigrationSection, extractReleaseNotes } from './release-notes';
import { decidePublishAction } from './release-plan';
import { classifyPrePush } from './release-prepush';
import { shouldRunStarterHeadLane } from './release-starter-head';
import {
  assertReleaseSubjectForTag,
  assertTagOnReleaseHead,
  isReleaseCommitSubject,
} from './release-subject';

const SHA = '1'.repeat(40);
const ZERO = '0'.repeat(40);
const BREAKING = '### \u26a0\ufe0f Breaking changes';

describe('release plan', () => {
  test('classifies by the REMOTE ref: HEAD:master and sha:refs/tags forms are covered', () => {
    // Regression: the classifier read the LOCAL ref, so `git push origin
    // HEAD:master` ran zero gates and `<sha>:refs/tags/v9` skipped preflight.
    expect(classifyPrePush(`HEAD ${SHA} refs/heads/master ${ZERO}\n`)).toEqual({
      verify: true,
      releaseTags: [],
      branchHeads: [SHA],
      defaultBranchHeads: [SHA],
      releaseBranchesOnly: false,
    });
    expect(classifyPrePush(`${SHA} ${SHA} refs/tags/v9.9.9 ${ZERO}\n`)).toEqual({
      verify: false,
      releaseTags: [{ tag: 'v9.9.9', sha: SHA }],
      branchHeads: [],
      defaultBranchHeads: [],
      releaseBranchesOnly: false,
    });
    expect(
      classifyPrePush(
        `HEAD ${SHA} refs/heads/master ${ZERO}\nHEAD ${SHA} refs/tags/create-stitchkit-v1.0.0 ${ZERO}\n`,
      ),
    ).toEqual({
      verify: true,
      releaseTags: [{ tag: 'create-stitchkit-v1.0.0', sha: SHA }],
      branchHeads: [SHA],
      defaultBranchHeads: [SHA],
      releaseBranchesOnly: false,
    });
  });

  test('a breaking release must carry the migration section that explains it', () => {
    const notes = `${BREAKING}\n\n- **\`createHandler\` no longer accepts \`foo\`** — it moved.`;
    const guide = '# Upgrading\n\n## Released migration: 0.56.0\n\n- old\n';

    expect(() => assertMigrationSection(guide, '0.57.0', notes)).toThrow(
      /must carry "## Released migration: 0\.57\.0"/,
    );
    expect(() =>
      assertMigrationSection(
        `${guide}\n## Released migration: 0.57.0\n\n- new\n`,
        '0.57.0',
        notes,
      ),
    ).not.toThrow();
  });

  test('an unpromoted heading does not satisfy the gate — that is the failure it exists for', () => {
    // 0.57.0's migration was written under `Unreleased migration`, never
    // promoted, and overwritten by the next author. The slug is irrelevant to
    // the gate: only the promoted heading counts.
    const notes = `${BREAKING}\n\n- something broke`;
    const guide = '## Unreleased migration: complete agent admission identity\n\n- text\n';
    expect(() => assertMigrationSection(guide, '0.57.0', notes)).toThrow(
      /Promote the "## Unreleased migration/,
    );
  });

  test('additive releases and versions below the floor pass without a section', () => {
    const additive = '### Added\n\n- an option nobody must adopt.';
    const breaking = `${BREAKING}\n\n- something broke`;
    expect(() => assertMigrationSection('', '0.59.0', additive)).not.toThrow();
    expect(() => assertMigrationSection('', '0.43.0', breaking)).not.toThrow();
    expect(() => assertMigrationSection('', '0.44.0', breaking)).toThrow();
  });

  test('a migration heading inside a fenced example does not satisfy the gate', () => {
    const notes = `${BREAKING}\n\n- something broke`;
    const guide = [
      '# Upgrading',
      '',
      '```md',
      '## Released migration: 0.57.0',
      '```',
      '',
    ].join('\n');
    expect(() => assertMigrationSection(guide, '0.57.0', notes)).toThrow();
  });

  test('release notes must be SUBSTANTIVE — a lone heading, comment or dot does not pass', () => {
    for (const body of ['### Added', '<!-- todo -->', '.', '### Added\n\n<!-- x -->\n\n.']) {
      expect(() =>
        extractReleaseNotes(`## [1.2.3]\n\n${body}\n\n## [1.2.2]\n- old`, '1.2.3'),
      ).toThrow(/no (substantive|non-empty)/);
    }
  });

  test('a stale tag SHA is refused before any publication step', () => {
    expect(() => assertTagOnReleaseHead(SHA, SHA)).not.toThrow();
    expect(() => assertTagOnReleaseHead(SHA, '2'.repeat(40))).toThrow(
      /current origin\/master/,
    );
    expect(() => assertTagOnReleaseHead('', SHA)).toThrow(/current origin\/master/);
  });

  test('a release tag on a non-release commit is refused, naming the honest order', async () => {
    // A tag cannot sit on a commit with no release commit beneath it.
    const history = async () => [
      {
        sha: 'a'.repeat(40),
        subject: 'test(server): align shutdown timing with force budget',
        files: ['packages/core/tests/a.test.ts'],
      },
    ];
    const train = async () =>
      JSON.stringify({ schemaVersion: 1, releases: [{ target: 'core', version: '0.55.0' }] });
    await expect(
      assertReleaseSubjectForTag({
        root: '/',
        tag: 'v0.55.0',
        head: SHA,
        read: train,
        history,
      }),
    ).rejects.toThrow('must point at a "release(train): … in 0.55.0" commit');
    await expect(
      assertReleaseSubjectForTag({
        root: '/',
        tag: 'v0.55.0',
        head: SHA,
        read: train,
        history: async () => [{ sha: SHA, subject: '', files: ['a'] }],
      }),
    ).rejects.toThrow('(empty)');
  });

  test('the version must match on boundaries — prerelease and longer numbers do not pass', async () => {
    // The train and the manifests name the version; a tag with a prerelease or longer number selects nothing.
    const history = async () => [
      { sha: SHA, subject: 'release(train): ship it in 0.56.0', files: ['CHANGELOG.md'] },
    ];
    const train = async () =>
      JSON.stringify({ schemaVersion: 1, releases: [{ target: 'core', version: '0.56.0' }] });
    for (const tag of ['v0.56.0-rc.1', 'v10.56.0', 'v0.56.00']) {
      await expect(
        assertReleaseSubjectForTag({ root: '/', tag, head: SHA, read: train, history }),
      ).rejects.toThrow(/does not select core@/);
    }
    await expect(
      assertReleaseSubjectForTag({
        root: '/',
        tag: 'v0.56.0',
        head: SHA,
        read: train,
        history,
      }),
    ).resolves.toBeUndefined();
  });

  test('the subject scope is bound to the tag namespace', async () => {
    // Only the train subject is a release commit, and a tag namespace is accepted
    // only when the train selects that package.
    expect(isReleaseCommitSubject('release(starter): scaffolder fixes in 0.3.3')).toBe(false);
    expect(isReleaseCommitSubject('release(core): transport policies in 0.55.0')).toBe(false);
    expect(isReleaseCommitSubject('release(train): transport policies in 0.55.0')).toBe(true);
    const history = async () => [
      {
        sha: SHA,
        subject: 'release(train): scaffolder fixes in 0.3.3',
        files: ['CHANGELOG.md'],
      },
    ];
    const train = async () =>
      JSON.stringify({
        schemaVersion: 1,
        releases: [{ target: 'create-stitchkit', version: '0.3.3' }],
      });
    await expect(
      assertReleaseSubjectForTag({
        root: '/',
        tag: 'v0.3.3',
        head: SHA,
        read: train,
        history,
      }),
    ).rejects.toThrow(/does not select core@0\.3\.3/);
    await expect(
      assertReleaseSubjectForTag({
        root: '/',
        tag: 'create-stitchkit-v0.3.3',
        head: SHA,
        read: train,
        history,
      }),
    ).resolves.toBeUndefined();
  });
  test('a missing or failed exact-SHA CI run is a loud refusal; success selects the run', () => {
    const runs = [
      { id: 1, head_sha: SHA, event: 'push', conclusion: 'failure' },
      { id: 2, head_sha: SHA, event: 'pull_request', conclusion: 'success' },
      { id: 3, head_sha: '2'.repeat(40), event: 'push', conclusion: 'success' },
    ];
    expect(() => selectSuccessfulCiRun([], SHA)).toThrow(/no push CI run exists/);
    expect(() => selectSuccessfulCiRun(runs, SHA)).toThrow(/no successful push CI run/);
    expect(
      selectSuccessfulCiRun(
        [...runs, { id: 4, head_sha: SHA, event: 'push', conclusion: 'success' }],
        SHA,
      ),
    ).toBe(4);
  });

  test('a repeated workflow is idempotent; a different published tarball is refused', () => {
    expect(decidePublishAction('abc', null)).toBe('publish');
    expect(decidePublishAction('abc', '')).toBe('publish');
    expect(decidePublishAction('abc', 'abc')).toBe('skip');
    expect(() => decidePublishAction('abc', 'def')).toThrow(/DIFFERENT tarball/);
  });

  test('an unaligned breaking release runs HEAD unless an exact deferred review exists', () => {
    const breaking = '### ⚠️ Breaking changes\n\n- managed server hard cut';
    expect(shouldRunStarterHeadLane('0.49.0', '^0.46.0', breaking)).toBe(true);
    expect(
      shouldRunStarterHeadLane('0.49.0', '^0.46.0', breaking, {
        coreVersion: '0.49.0',
        outcome: 'deferred',
        reason: 'The target lane must remain on the published minor until core ships.',
      }),
    ).toBe(false);
    expect(
      shouldRunStarterHeadLane('0.49.0', '^0.46.0', breaking, {
        coreVersion: '0.48.0',
        outcome: 'deferred',
        reason: 'stale review',
      }),
    ).toBe(true);
    expect(
      shouldRunStarterHeadLane('0.49.0', '^0.46.0', breaking, {
        coreVersion: '0.49.0',
        outcome: 'deferred',
        reason: '   ',
      }),
    ).toBe(true);
    expect(
      shouldRunStarterHeadLane('0.49.0', '^0.46.0', breaking, {
        coreVersion: '0.49.0',
        outcome: 'compatible',
        reason: 'must prove compatibility by running the lane',
      }),
    ).toBe(true);
    expect(shouldRunStarterHeadLane('0.49.0', '^0.49.0', breaking)).toBe(true);
    expect(shouldRunStarterHeadLane('0.49.0', '^0.46.0', '### Added\n\n- additive')).toBe(
      true,
    );
    expect(shouldRunStarterHeadLane('1.0.0', '^0.46.0', breaking)).toBe(true);
    expect(shouldRunStarterHeadLane('0.49.0', 'workspace:*', breaking)).toBe(true);
  });
});

test('the successful push run with the lowest id is selected, because later runs of the SHA are empty plans', () => {
  const runs = [
    { id: 9, head_sha: SHA, event: 'push', conclusion: 'success' },
    { id: 4, head_sha: SHA, event: 'push', conclusion: 'success' },
    { id: 2, head_sha: SHA, event: 'push', conclusion: 'failure' },
    { id: 1, head_sha: SHA, event: 'pull_request', conclusion: 'success' },
  ];
  expect(selectSuccessfulCiRun(runs, SHA)).toBe(4);
});

describe('the one entrypoint', () => {
  const plan = (...args: string[]) =>
    Bun.spawnSync(['bun', `${import.meta.dir}/release-plan.ts`, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

  test('only the train is released: single-target releases are not a command', () => {
    for (const target of ['core', 'create-stitchkit', 'tui']) {
      const result = plan('release', target);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain('Usage: release-plan.ts release train');
    }
  });

  test('the root scripts carry one release command', async () => {
    const manifest = await Bun.file(`${import.meta.dir}/../package.json`).json();
    const names = Object.keys(manifest.scripts).filter((name) => name.startsWith('release:'));
    expect(names.sort()).toEqual(['release:check', 'release:train']);
  });

  test('a CI question names a full SHA or is refused before it reaches GitHub', async () => {
    await expect(askReleaseCi('/', 'abc')).rejects.toThrow('full commit SHA');
    await expect(askReleaseCi('/', 'A'.repeat(40))).rejects.toThrow('full commit SHA');
  });
});
