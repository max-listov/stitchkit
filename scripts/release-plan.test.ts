import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertMigrationSection,
  assertReleaseCommitSubject,
  assertTagOnReleaseHead,
  assertVersionCalibre,
  classifyPrePush,
  decidePublishAction,
  extractReleaseNotes,
  isReleaseCommitSubject,
  MIGRATION_CHANNELS,
  releasedVersionsInOrder,
  releasePlanForTag,
  releaseScopeForTag,
  selectSuccessfulCiRun,
  shouldRunStarterHeadLane,
} from './release-plan';

const SHA = '1'.repeat(40);
const ZERO = '0'.repeat(40);
const BREAKING = '### \u26a0\ufe0f Breaking changes';

describe('release plan', () => {
  test('classifies branch, tag, deletion and mixed pushes without duplicate gates', () => {
    expect(classifyPrePush(`refs/heads/topic ${SHA} refs/heads/topic ${ZERO}\n`)).toEqual({
      verify: true,
      releaseTags: [],
      branchHeads: [SHA],
    });
    expect(classifyPrePush(`refs/tags/v1.2.3 ${ZERO} refs/tags/v1.2.3 ${SHA}\n`)).toEqual({
      verify: false,
      releaseTags: [],
      branchHeads: [],
    });
    expect(
      classifyPrePush(
        `refs/heads/main ${SHA} refs/heads/main ${ZERO}\nrefs/tags/v1.2.3 ${SHA} refs/tags/v1.2.3 ${ZERO}\n`,
      ),
    ).toEqual({
      verify: true,
      releaseTags: [{ tag: 'v1.2.3', sha: SHA }],
      branchHeads: [SHA],
    });
  });

  test('classifies by the REMOTE ref: HEAD:master and sha:refs/tags forms are covered', () => {
    // Regression: the classifier read the LOCAL ref, so `git push origin
    // HEAD:master` ran zero gates and `<sha>:refs/tags/v9` skipped preflight.
    expect(classifyPrePush(`HEAD ${SHA} refs/heads/master ${ZERO}\n`)).toEqual({
      verify: true,
      releaseTags: [],
      branchHeads: [SHA],
    });
    expect(classifyPrePush(`${SHA} ${SHA} refs/tags/v9.9.9 ${ZERO}\n`)).toEqual({
      verify: false,
      releaseTags: [{ tag: 'v9.9.9', sha: SHA }],
      branchHeads: [],
    });
    expect(
      classifyPrePush(
        `HEAD ${SHA} refs/heads/master ${ZERO}\nHEAD ${SHA} refs/tags/create-stitchkit-v1.0.0 ${ZERO}\n`,
      ),
    ).toEqual({
      verify: true,
      releaseTags: [{ tag: 'create-stitchkit-v1.0.0', sha: SHA }],
      branchHeads: [SHA],
    });
  });

  test('a release tag on a non-release commit is refused, naming the honest order', () => {
    // The 0.55.0 shape: the release commit was pushed before it was green, a
    // follow-up fix became the head, and the tag had to land on the fix.
    expect(() =>
      assertReleaseCommitSubject(
        'test(server): align shutdown timing with force budget',
        '0.55.0',
        'core',
      ),
    ).toThrow('must point at a "release(core): … in 0.55.0" commit');
    expect(() => assertReleaseCommitSubject('', '0.55.0', 'core')).toThrow('(empty)');
  });

  test('the version must match on boundaries — prerelease and longer numbers do not pass', () => {
    expect(() =>
      assertReleaseCommitSubject('release(core): ship it in 0.56.0-rc.1', '0.56.0', 'core'),
    ).toThrow('must name version 0.56.0 exactly');
    expect(() =>
      assertReleaseCommitSubject('release(core): bump to 10.56.0', '0.56.0', 'core'),
    ).toThrow('must name version 0.56.0 exactly');
    expect(() =>
      assertReleaseCommitSubject(
        'release(core): managed tools and CLI lifecycle in 0.54.0',
        '0.55.0',
        'core',
      ),
    ).toThrow('must name version 0.55.0 exactly');
  });

  test('the subject scope is bound to the tag namespace', () => {
    // A starter release commit must not be able to carry a core tag when both
    // packages happen to sit on the same version.
    expect(releaseScopeForTag('v0.3.3')).toBe('core');
    expect(releaseScopeForTag('create-stitchkit-v0.3.3')).toBe('starter');
    expect(() =>
      assertReleaseCommitSubject(
        'release(starter): scaffolder fixes in 0.3.3',
        '0.3.3',
        'core',
      ),
    ).toThrow('release(core)');
    expect(() =>
      assertReleaseCommitSubject(
        'release(core): transport policies and async operations in 0.55.0',
        '0.55.0',
        'core',
      ),
    ).not.toThrow();
    expect(() =>
      assertReleaseCommitSubject(
        'release(starter): safe loopback bind default in 0.3.3',
        '0.3.3',
        'starter',
      ),
    ).not.toThrow();
  });

  test('a stale tag SHA is refused before any publication step', () => {
    expect(() => assertTagOnReleaseHead(SHA, SHA)).not.toThrow();
    expect(() => assertTagOnReleaseHead(SHA, '2'.repeat(40))).toThrow(
      /current origin\/master/,
    );
    expect(() => assertTagOnReleaseHead('', SHA)).toThrow(/current origin\/master/);
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

  test('maps both tag namespaces to one release model', () => {
    expect(releasePlanForTag('v1.2.3')).toMatchObject({ target: 'core', version: '1.2.3' });
    expect(releasePlanForTag('create-stitchkit-v2.0.0')).toMatchObject({
      target: 'create-stitchkit',
      version: '2.0.0',
    });
    expect(() => releasePlanForTag('other-v1')).toThrow('Unsupported release tag');
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

  test('extracts a non-empty exact-version changelog section', () => {
    expect(
      extractReleaseNotes(
        '# Changelog\n\n## [1.2.3]\n\n### Added\n\n- one substantial release note\n\n## [1.2.2]\n- old',
        '1.2.3',
      ),
    ).toContain('- one substantial release note');
    expect(() => extractReleaseNotes('## [1.2.3]\n\n## [1.2.2]\n- old', '1.2.3')).toThrow(
      /no (substantive|non-empty)/,
    );
  });

  test('release notes must be SUBSTANTIVE — a lone heading, comment or dot does not pass', () => {
    for (const body of ['### Added', '<!-- todo -->', '.', '### Added\n\n<!-- x -->\n\n.']) {
      expect(() =>
        extractReleaseNotes(`## [1.2.3]\n\n${body}\n\n## [1.2.2]\n- old`, '1.2.3'),
      ).toThrow(/no (substantive|non-empty)/);
    }
  });

  test('a version heading inside a code fence is example text, not a section boundary', () => {
    const changelog = [
      '## [1.2.3]',
      '',
      '- migration snippet below is real content',
      '',
      '```md',
      '## [1.0.0]',
      '```',
      '',
      '- and a second substantial note',
      '',
      '## [1.2.2]',
      '- old',
    ].join('\n');
    const notes = extractReleaseNotes(changelog, '1.2.3');
    expect(notes).toContain('and a second substantial note');
    expect(notes).toContain('```md');
  });
  test('a breaking change may not ship as a patch — the caret would carry it silently', () => {
    const changelog = [
      '## [0.56.1]',
      '',
      `${BREAKING}`,
      '',
      '- **`createHandler` no longer accepts `foo`** — it moved to `bar`.',
      '',
      '## [0.56.0]',
      '- the previous release',
    ].join('\n');

    expect(() => assertVersionCalibre(changelog, '0.56.1')).toThrow(
      /patch bump from 0\.56\.0/,
    );
  });

  test('the same breaking notes pass as a minor, and additive notes pass as a patch', () => {
    const breakingMinor = [
      '## [0.57.0]',
      '',
      `${BREAKING}`,
      '',
      '- **`createHandler` no longer accepts `foo`** — it moved to `bar`.',
      '',
      '## [0.56.0]',
      '- the previous release',
    ].join('\n');
    const additivePatch = [
      '## [0.56.1]',
      '',
      '### Added',
      '',
      '- an entirely additive option nobody has to adopt.',
      '',
      '## [0.56.0]',
      '- the previous release',
    ].join('\n');

    expect(() => assertVersionCalibre(breakingMinor, '0.57.0')).not.toThrow();
    expect(() => assertVersionCalibre(additivePatch, '0.56.1')).not.toThrow();
  });

  test('the first release in a changelog has no predecessor to compare against', () => {
    const changelog = ['## [0.1.0]', '', `${BREAKING}`, '', '- the very first entry.'].join(
      '\n',
    );
    expect(() => assertVersionCalibre(changelog, '0.1.0')).not.toThrow();
  });

  test('version headings are read in order and ignore fenced examples', () => {
    const changelog = [
      '## [1.2.3]',
      '- real',
      '',
      '```md',
      '## [9.9.9]',
      '```',
      '',
      '## [1.2.2]',
      '- older',
    ].join('\n');
    expect(releasedVersionsInOrder(changelog)).toEqual(['1.2.3', '1.2.2']);
  });
  test('a pushed branch tip is reported so a release push can prove the starter on HEAD', () => {
    // `verify` alone cannot tell WHICH commit is being pushed, and the packed
    // HEAD starter lane is worth its minutes only on the one release push.
    const other = '2'.repeat(40);
    expect(
      classifyPrePush(
        `HEAD ${SHA} refs/heads/master ${ZERO}\nHEAD ${other} refs/heads/topic ${ZERO}\n`,
      ).branchHeads,
    ).toEqual([SHA, other]);
    expect(
      classifyPrePush(`refs/heads/master ${SHA} refs/heads/master ${ZERO}\n`.repeat(2))
        .branchHeads,
    ).toEqual([SHA]);
  });

  test('only a release commit subject opens the extra release-push gate', () => {
    expect(isReleaseCommitSubject('release(core): cancellations in 0.56.1')).toBe(true);
    expect(isReleaseCommitSubject('  release(starter): a starter cut in 0.4.0  ')).toBe(true);
    expect(isReleaseCommitSubject('fix(server): an error code map may be partial')).toBe(
      false,
    );
    expect(isReleaseCommitSubject('release: 0.4.0')).toBe(false);
    expect(isReleaseCommitSubject('chore: mention release(core): in a body')).toBe(false);
    expect(isReleaseCommitSubject('')).toBe(false);
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
});

test('a release that promotes one migration section but leaves five queued is refused', () => {
  // The half-satisfied shape: the gate proves a heading exists, and a release
  // with six queued sections passes it by promoting the first. The leftovers
  // are then overwritten by the next author, which is the 0.57.0 failure.
  const notes = '### ⚠️ Breaking changes\n- something broke';
  const promoted = [
    '## Released migration: 0.60.0',
    'text',
    '## Unreleased migration: still queued',
    'text',
  ].join('\n');

  expect(() =>
    assertMigrationSection('## Released migration: 0.60.0', '0.60.0', notes),
  ).not.toThrow();
  expect(() => assertMigrationSection(promoted, '0.60.0', notes)).toThrow(/still carries 1/);
});

test('a queued heading inside a fenced block is documentation, not a queue entry', () => {
  const notes = '### ⚠️ Breaking changes\n- something broke';
  const fence = '```';
  const guide = [
    '## Released migration: 0.60.0',
    fence,
    '## Unreleased migration: <slug>',
    fence,
  ].join('\n');

  expect(() => assertMigrationSection(guide, '0.60.0', notes)).not.toThrow();
});

describe('the scaffolder has a migration channel of its own', () => {
  const breaking =
    '### ⚠️ Breaking changes\n\n- **`app.config.json` is now `project.json`.**\n';

  test('a breaking starter release without a promoted section is refused, by its own path', () => {
    expect(() =>
      assertMigrationSection('', '0.4.0', breaking, MIGRATION_CHANNELS['create-stitchkit']),
    ).toThrow(
      /packages\/create-stitchkit\/UPGRADING\.md must carry "## Released migration: 0\.4\.0"/,
    );
  });

  test('the starter floor is its own — an older breaking release is not made retroactive', () => {
    // The channel starts at 0.4.0. Demanding sections for releases that shipped
    // before it existed produces documents nobody wrote for a reader nobody had.
    expect(() =>
      assertMigrationSection('', '0.3.3', breaking, MIGRATION_CHANNELS['create-stitchkit']),
    ).not.toThrow();
  });

  test('a promoted section satisfies it, and a leftover queued one does not', () => {
    const promoted = '## Released migration: 0.4.0\n\n### the project declares itself\n';
    expect(() =>
      assertMigrationSection(
        promoted,
        '0.4.0',
        breaking,
        MIGRATION_CHANNELS['create-stitchkit'],
      ),
    ).not.toThrow();
    expect(() =>
      assertMigrationSection(
        `${promoted}\n## Unreleased migration: something else\n`,
        '0.4.0',
        breaking,
        MIGRATION_CHANNELS['create-stitchkit'],
      ),
    ).toThrow(/packages\/create-stitchkit\/UPGRADING\.md still carries 1/);
  });

  test('the two channels do not share a guide', () => {
    expect(MIGRATION_CHANNELS.core.guidePath).not.toBe(
      MIGRATION_CHANNELS['create-stitchkit'].guidePath,
    );
  });
});

describe('a gate that cannot check refuses instead of passing', () => {
  const breaking = '### ⚠️ Breaking changes';

  test('a version with notes but no plain release heading is refused', () => {
    // `extractReleaseNotes` accepts any escaped version, so a pre-release
    // spelling produced notes while `releasedVersionsInOrder` (plain x.y.z
    // only) did not list it — and the calibre gate returned without checking,
    // for exactly the shape most likely to carry an unreviewed break.
    const changelog = [
      '## [0.56.1-rc.1]',
      '',
      breaking,
      '',
      '- **`createHandler` no longer accepts `foo`** — it moved to `bar`.',
      '',
      '## [0.56.0]',
      '- the previous release',
    ].join('\n');

    expect(() => assertVersionCalibre(changelog, '0.56.1-rc.1')).toThrow(
      /carries release notes but no "## \[0\.56\.1-rc\.1\]" heading/,
    );
  });
});

describe('a migration guide reads newest first', () => {
  // A reader is told to read every section in a range. `0.49.0 → 0.46.0 →
  // 0.48.0 → 0.47.0` gives them that range shuffled, and the two sections most
  // likely to be misplaced are the two most recently appended — which is what
  // happened.
  for (const [target, channel] of Object.entries(MIGRATION_CHANNELS)) {
    test(`${target}: sections descend by version`, () => {
      const guide = readFileSync(resolve(import.meta.dir, '..', channel.guidePath), 'utf8');
      const versions = [
        ...guide.matchAll(/^## Released migration: (\d+\.\d+\.\d+)\s*$/gm),
      ].map((match) => match[1] ?? '');
      expect(versions.length).toBeGreaterThan(0);
      const descending = [...versions].sort((left, right) => comparePreOne(right, left));
      expect(versions).toEqual(descending);
    });
  }
});

function comparePreOne(left: string, right: string): number {
  const [leftMajor = 0, leftMinor = 0, leftPatch = 0] = left.split('.').map(Number);
  const [rightMajor = 0, rightMinor = 0, rightPatch = 0] = right.split('.').map(Number);
  return leftMajor - rightMajor || leftMinor - rightMinor || leftPatch - rightPatch;
}
