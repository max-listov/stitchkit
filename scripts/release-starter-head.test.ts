import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shouldRunStarterHeadLane, starterHeadDecision } from './release-starter-head';

const created: string[] = [];
afterAll(async () => {
  for (const path of created) await rm(path, { recursive: true, force: true });
});

const breaking = '### ⚠️ Breaking changes\n\n- `stitchkit/server` — hard cut';
const breakingWithSecurity = [
  '### ⚠️ Breaking changes',
  '',
  '- `stitchkit/server` — hard cut',
  '',
  '### Security',
  '',
  '- Close origin bypass on loopback guard.',
].join('\n');
const deferredReview = {
  coreVersion: '0.127.0',
  outcome: 'deferred',
  reason: 'Starter will update in the follow-up train.',
};
const followUpReview = { ...deferredReview, followUp: 'create-stitchkit@0.7.0' };

/** Core 0.127.0 against a starter on `starterTarget`, released as create-stitchkit 0.6.23. */
function decide(starterTarget: string, releaseNotes: string, review?: unknown): boolean {
  return shouldRunStarterHeadLane({
    coreVersion: '0.127.0',
    starterTarget,
    starterVersion: '0.6.23',
    releaseNotes,
    review,
  });
}

async function writeFixture(options: {
  changelog: string;
  review: unknown;
  starterTarget?: string;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'starter-head-security-'));
  created.push(root);
  await mkdir(join(root, 'packages/core'), { recursive: true });
  await mkdir(join(root, 'packages/create-stitchkit/template'), { recursive: true });
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'packages/core/package.json'), '{"version":"0.127.0"}\n');
  await writeFile(
    join(root, 'packages/create-stitchkit/package.json'),
    '{"version":"0.6.23"}\n',
  );
  await writeFile(
    join(root, 'packages/create-stitchkit/template/package.json'),
    `{"catalog":{"stitchkit":"${options.starterTarget ?? '^0.126.0'}"}}\n`,
  );
  await writeFile(join(root, 'CHANGELOG.md'), options.changelog);
  await writeFile(
    join(root, 'scripts/starter-head-review.json'),
    `${JSON.stringify(options.review, null, 2)}\n`,
  );
  return root;
}

describe('a security release defers the starter only where the starter would not receive it', () => {
  test('negative control: a deferral on the same minor is refused, with or without followUp', () => {
    expect(() => decide('^0.127.0', breakingWithSecurity, deferredReview)).toThrow(
      /### Security.*same minor/,
    );
    expect(() => decide('^0.127.0', breakingWithSecurity, followUpReview)).toThrow(
      /### Security.*same minor/,
    );
    // A target outside the pre-1.0 caret form cannot prove another minor: refused, not skipped.
    expect(() => decide('workspace:*', breakingWithSecurity, followUpReview)).toThrow(
      /### Security/,
    );
  });

  test('another minor without followUp is refused', () => {
    expect(() => decide('^0.126.0', breakingWithSecurity, deferredReview)).toThrow(
      /### Security.*followUp/,
    );
  });

  test('a followUp that is not a later create-stitchkit release is refused', () => {
    for (const followUp of [
      'create-stitchkit@0.6.23',
      'create-stitchkit@0.6.22',
      'stitchkit@0.7.0',
      'create-stitchkit@0.7',
      'create-stitchkit@^0.7.0',
      '0.7.0',
      7,
    ]) {
      expect(() =>
        decide('^0.126.0', breakingWithSecurity, { ...deferredReview, followUp }),
      ).toThrow(/followUp/);
    }
  });

  test('another minor, a later followUp and a reason skip the HEAD lane', () => {
    expect(decide('^0.126.0', breakingWithSecurity, followUpReview)).toBe(false);
  });

  test('a security deferral without a reason is refused even with a valid followUp', () => {
    expect(() =>
      decide('^0.126.0', breakingWithSecurity, { ...followUpReview, reason: '  ' }),
    ).toThrow(/### Security.*reason/);
  });

  test('without ### Security the deferral is unchanged; a malformed followUp is still refused', () => {
    expect(decide('^0.126.0', breaking, deferredReview)).toBe(false);
    expect(decide('^0.126.0', breaking, followUpReview)).toBe(false);
    expect(decide('^0.127.0', breaking, deferredReview)).toBe(true);
    expect(() =>
      decide('^0.126.0', breaking, { ...deferredReview, followUp: 'create-stitchkit@0.6.0' }),
    ).toThrow(/followUp/);
  });

  test('a security release without a deferred review runs the lane without throwing', () => {
    expect(decide('^0.126.0', breakingWithSecurity)).toBe(true);
    expect(decide('^0.127.0', breakingWithSecurity)).toBe(true);
    expect(
      decide('^0.126.0', breakingWithSecurity, {
        coreVersion: '0.127.0',
        outcome: 'compatible',
        reason: 'verified against HEAD',
      }),
    ).toBe(true);
    // A stale review for another core version is not a deferral of this one.
    expect(
      decide('^0.127.0', breakingWithSecurity, { ...followUpReview, coreVersion: '0.126.0' }),
    ).toBe(true);
  });

  test('ignores ### Security inside fenced code blocks', () => {
    const fencedSecurity = [
      breaking,
      '',
      '```md',
      '### Security',
      '- example only',
      '```',
    ].join('\n');
    expect(decide('^0.127.0', fencedSecurity, deferredReview)).toBe(true);
    expect(decide('^0.126.0', fencedSecurity, deferredReview)).toBe(false);
  });
});

describe('starterHeadDecision reads the tree the release ships', () => {
  const security = `## [0.127.0] - 2026-11-23\n\n${breakingWithSecurity}\n`;

  test('a security release on another minor skips HEAD only when the review names the follow-up starter', async () => {
    expect(
      await starterHeadDecision(
        await writeFixture({ changelog: security, review: followUpReview }),
      ),
    ).toBe('skip');
    await expect(
      starterHeadDecision(await writeFixture({ changelog: security, review: deferredReview })),
    ).rejects.toThrow(/followUp/);
  });

  test('negative control: the same security deferral on the same minor is refused', async () => {
    await expect(
      starterHeadDecision(
        await writeFixture({
          changelog: security,
          review: followUpReview,
          starterTarget: '^0.127.0',
        }),
      ),
    ).rejects.toThrow(/### Security.*same minor/);
  });

  test('without ### Security the deferral skips, and a security section of an older release does not count', async () => {
    const normal = `## [0.127.0] - 2026-11-23\n\n${breaking}\n`;
    expect(
      await starterHeadDecision(
        await writeFixture({ changelog: normal, review: deferredReview }),
      ),
    ).toBe('skip');
    const olderSecurity = [
      '## [0.127.0] - 2026-11-23',
      '',
      breaking,
      '',
      '## [0.126.0] - 2026-11-20',
      '',
      '### Security',
      '',
      '- Earlier security fix already shipped in 0.126.0.',
      '',
    ].join('\n');
    expect(
      await starterHeadDecision(
        await writeFixture({ changelog: olderSecurity, review: deferredReview }),
      ),
    ).toBe('skip');
  });
});

describe('an unaligned hard cut defers HEAD only by an exact-version review', () => {
  test('an unaligned breaking release runs HEAD unless an exact deferred review exists', () => {
    const breaking = '### ⚠️ Breaking changes\n\n- managed server hard cut';
    const decide = (
      coreVersion: string,
      starterTarget: string,
      releaseNotes: string,
      review?: unknown,
    ) =>
      shouldRunStarterHeadLane({
        coreVersion,
        starterTarget,
        starterVersion: '0.4.0',
        releaseNotes,
        review,
      });
    expect(decide('0.49.0', '^0.46.0', breaking)).toBe(true);
    expect(
      decide('0.49.0', '^0.46.0', breaking, {
        coreVersion: '0.49.0',
        outcome: 'deferred',
        reason: 'The target lane must remain on the published minor until core ships.',
      }),
    ).toBe(false);
    expect(
      decide('0.49.0', '^0.46.0', breaking, {
        coreVersion: '0.48.0',
        outcome: 'deferred',
        reason: 'stale review',
      }),
    ).toBe(true);
    expect(
      decide('0.49.0', '^0.46.0', breaking, {
        coreVersion: '0.49.0',
        outcome: 'deferred',
        reason: '   ',
      }),
    ).toBe(true);
    expect(
      decide('0.49.0', '^0.46.0', breaking, {
        coreVersion: '0.49.0',
        outcome: 'compatible',
        reason: 'must prove compatibility by running the lane',
      }),
    ).toBe(true);
    expect(decide('0.49.0', '^0.49.0', breaking)).toBe(true);
    expect(decide('0.49.0', '^0.46.0', '### Added\n\n- additive')).toBe(true);
    expect(decide('1.0.0', '^0.46.0', breaking)).toBe(true);
    expect(decide('0.49.0', 'workspace:*', breaking)).toBe(true);
  });
});
