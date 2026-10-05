import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertBreakingAudience,
  assertMigrationSection,
  assertVersionCalibre,
  breakingMarkers,
  comparePreOneVersions,
  extractReleaseNotes,
  releasedVersionsInOrder,
} from './release-notes';
import { RELEASE_TARGETS } from './release-train';

const BREAKING = '### ⚠️ Breaking changes';

describe('release notes', () => {
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
      assertMigrationSection(
        '',
        '0.4.0',
        breaking,
        RELEASE_TARGETS['create-stitchkit'].migration,
      ),
    ).toThrow(
      /packages\/create-stitchkit\/UPGRADING\.md must carry "## Released migration: 0\.4\.0"/,
    );
  });

  test('the starter floor is its own — an older breaking release is not made retroactive', () => {
    // The channel starts at 0.4.0. Demanding sections for releases that shipped
    // before it existed produces documents nobody wrote for a reader nobody had.
    expect(() =>
      assertMigrationSection(
        '',
        '0.3.3',
        breaking,
        RELEASE_TARGETS['create-stitchkit'].migration,
      ),
    ).not.toThrow();
  });

  test('a promoted section satisfies it, and a leftover queued one does not', () => {
    const promoted = '## Released migration: 0.4.0\n\n### the project declares itself\n';
    expect(() =>
      assertMigrationSection(
        promoted,
        '0.4.0',
        breaking,
        RELEASE_TARGETS['create-stitchkit'].migration,
      ),
    ).not.toThrow();
    expect(() =>
      assertMigrationSection(
        `${promoted}\n## Unreleased migration: something else\n`,
        '0.4.0',
        breaking,
        RELEASE_TARGETS['create-stitchkit'].migration,
      ),
    ).toThrow(/packages\/create-stitchkit\/UPGRADING\.md still carries 1/);
  });

  test('the two channels do not share a guide', () => {
    expect(RELEASE_TARGETS.core.migration.guidePath).not.toBe(
      RELEASE_TARGETS['create-stitchkit'].migration.guidePath,
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
  for (const [target, { migration: channel }] of Object.entries(RELEASE_TARGETS)) {
    test(`${target}: sections descend by version`, () => {
      const guide = readFileSync(resolve(import.meta.dir, '..', channel.guidePath), 'utf8');
      const versions = [
        ...guide.matchAll(/^## Released migration: (\d+\.\d+\.\d+)\s*$/gm),
      ].map((match) => match[1] ?? '');
      expect(versions.length).toBeGreaterThan(0);
      const descending = [...versions].sort((left, right) =>
        comparePreOneVersions(right, left),
      );
      expect(versions).toEqual(descending);
    });
  }
});
describe('a breaking section says who has to act', () => {
  const breaking = ['### ⚠️ Breaking changes', '', '- **Something moved.**'].join('\n');

  test('refuses a breaking section with no audience line', () => {
    expect(() => assertBreakingAudience(breaking, '0.9.0')).toThrow(/Who must act/);
  });

  test('accepts one that opens with it', () => {
    const withAudience = [
      '### ⚠️ Breaking changes',
      '',
      '**Who must act:** nobody — the shape moved under a helper.',
      '',
      '- **Something moved.**',
    ].join('\n');
    expect(() => assertBreakingAudience(withAudience, '0.9.0')).not.toThrow();
  });

  test('says nothing about a purely additive release', () => {
    expect(() => assertBreakingAudience('### Added\n\n- a thing', '0.9.0')).not.toThrow();
  });

  test('the release notes this repository ships pass it', async () => {
    const changelog = await Bun.file(`${import.meta.dir}/../CHANGELOG.md`).text();
    const notes = extractReleaseNotes(changelog, '0.63.0');
    expect(() => assertBreakingAudience(notes, '0.63.0')).not.toThrow();
  });
});

describe('a break never ships as a patch, whatever its section is called', () => {
  const asPatch = (body: string) =>
    ['## [0.56.1]', '', body, '', '## [0.56.0]', '- the previous release'].join('\n');
  const asMinor = (body: string) =>
    ['## [0.57.0]', '', body, '', '## [0.56.0]', '- the previous release'].join('\n');
  const delivery = [
    '### ⚠️ Delivery migration',
    '',
    '- A packager that assumed one output file must move to `--outdir`.',
  ].join('\n');
  const lead = [
    '### Fixed',
    '',
    '**Who must act:** wrappers that append `--json` to the arguments they forward.',
    '',
    '- Repeated options are refused.',
  ].join('\n');

  test('a warning heading with any other name is refused in a patch', () => {
    expect(() => assertVersionCalibre(asPatch(delivery), '0.56.1')).toThrow(
      /declares a break .* patch bump from 0\.56\.0/,
    );
  });

  test('a `Who must act` line under another heading is refused in a patch', () => {
    expect(() => assertVersionCalibre(asPatch(lead), '0.56.1')).toThrow(/patch bump/);
  });

  test('an item that opens with Breaking is refused in a patch', () => {
    for (const item of [
      '- **Breaking:** the flag moved.',
      '- Breaking change: the flag moved.',
    ]) {
      expect(() => assertVersionCalibre(asPatch(`### Fixed\n\n${item}`), '0.56.1')).toThrow(
        /patch bump/,
      );
    }
  });

  test('the same sections pass as a minor', () => {
    expect(() => assertVersionCalibre(asMinor(delivery), '0.57.0')).not.toThrow();
    expect(() => assertVersionCalibre(asMinor(lead), '0.57.0')).not.toThrow();
  });

  test('a marker inside a fenced example is documentation, and prose that mentions breaking passes', () => {
    const fence = '```';
    const example = ['### Fixed', '', fence, BREAKING, '**Who must act:** nobody', fence].join(
      '\n',
    );
    expect(() => assertVersionCalibre(asPatch(example), '0.56.1')).not.toThrow();
    const prose =
      '### Fixed\n\n- A retry loop no longer retries after breaking out of the stream.';
    expect(() => assertVersionCalibre(asPatch(prose), '0.56.1')).not.toThrow();
  });

  test('every declaring line is listed', () => {
    expect(breakingMarkers(`${delivery}\n\n${lead}`)).toEqual([
      '### ⚠️ Delivery migration',
      '**Who must act:** wrappers that append `--json` to the arguments they forward.',
    ]);
  });
});
