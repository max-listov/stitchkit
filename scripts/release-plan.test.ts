import { describe, expect, test } from 'bun:test';
import {
  assertReleaseCommitSubject,
  assertTagOnReleaseHead,
  assertVersionCalibre,
  classifyPrePush,
  decidePublishAction,
  extractReleaseNotes,
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
    });
    expect(classifyPrePush(`refs/tags/v1.2.3 ${ZERO} refs/tags/v1.2.3 ${SHA}\n`)).toEqual({
      verify: false,
      releaseTags: [],
    });
    expect(
      classifyPrePush(
        `refs/heads/main ${SHA} refs/heads/main ${ZERO}\nrefs/tags/v1.2.3 ${SHA} refs/tags/v1.2.3 ${ZERO}\n`,
      ),
    ).toEqual({ verify: true, releaseTags: [{ tag: 'v1.2.3', sha: SHA }] });
  });

  test('classifies by the REMOTE ref: HEAD:master and sha:refs/tags forms are covered', () => {
    // Regression: the classifier read the LOCAL ref, so `git push origin
    // HEAD:master` ran zero gates and `<sha>:refs/tags/v9` skipped preflight.
    expect(classifyPrePush(`HEAD ${SHA} refs/heads/master ${ZERO}\n`)).toEqual({
      verify: true,
      releaseTags: [],
    });
    expect(classifyPrePush(`${SHA} ${SHA} refs/tags/v9.9.9 ${ZERO}\n`)).toEqual({
      verify: false,
      releaseTags: [{ tag: 'v9.9.9', sha: SHA }],
    });
    expect(
      classifyPrePush(
        `HEAD ${SHA} refs/heads/master ${ZERO}\nHEAD ${SHA} refs/tags/create-stitchkit-v1.0.0 ${ZERO}\n`,
      ),
    ).toEqual({
      verify: true,
      releaseTags: [{ tag: 'create-stitchkit-v1.0.0', sha: SHA }],
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

  test('skips HEAD only for an unaligned, changelog-proven breaking core minor', () => {
    const breaking = '### ⚠️ Breaking changes\n\n- managed server hard cut';
    expect(shouldRunStarterHeadLane('0.49.0', '^0.46.0', breaking)).toBe(false);
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
});
