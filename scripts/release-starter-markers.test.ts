import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { git } from './local-git';
import { withLockfile } from './lockfile-fixture';
import {
  assertStarterMigrationMarkers,
  STARTER_MIGRATION_MARKERS_SINCE,
} from './release-derived';
import { comparePreOneVersions } from './release-notes';
import { checkWorkingTree } from './release-plan';

describe('starter migration markers', () => {
  const CHANGELOG = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '## [0.126.0] - 2026-11-20',
    '',
    '### Added',
    '- Something mentioning 0.999.0 in prose.',
    '',
    '## [0.123.0] - 2026-11-10',
    '',
    '### Changed',
    '- Something else.',
  ].join('\n');

  test('a released section before the rule is history and is not judged; one from the rule on is', () => {
    const before = [
      '# Upgrading',
      '',
      '## Released migration: 0.6.23',
      '',
      '### watch hub reads one request',
      '',
      'Take it together with stitchkit 0.126.0.',
    ].join('\n');
    expect(assertStarterMigrationMarkers(before, CHANGELOG)).toBe(0);
    expect(() =>
      assertStarterMigrationMarkers(
        before.replace('0.6.23', STARTER_MIGRATION_MARKERS_SINCE),
        CHANGELOG,
      ),
    ).toThrow(/must start with/);
  });

  test('a migration subsection or bare released section without a marker is refused', () => {
    const missingReleased = [
      '# Upgrading',
      '',
      '## Released migration: 0.6.25',
      '',
      '### watch hub reads one request',
      '',
      'Take it together with stitchkit 0.126.0.',
    ].join('\n');
    expect(() => assertStarterMigrationMarkers(missingReleased, CHANGELOG)).toThrow(
      /must start with "\*\*Required\.\*\*", "\*\*Voluntary\.\*\*" or "\*\*With stitchkit X\.Y\.Z\.\*\*"/,
    );

    const missingBareReleased = [
      '# Upgrading',
      '',
      '## Released migration: 0.6.24',
      '',
      'Do this edit without a marker.',
    ].join('\n');
    expect(() => assertStarterMigrationMarkers(missingBareReleased, CHANGELOG)).toThrow(
      /must start with/,
    );

    const missingUnreleased = [
      '# Upgrading',
      '',
      '## Unreleased migration: new rule',
      '',
      'Voluntary, take it when ready.',
    ].join('\n');
    expect(() => assertStarterMigrationMarkers(missingUnreleased, CHANGELOG)).toThrow(
      /must start with/,
    );

    const fenceBeforeMarker = [
      '# Upgrading',
      '',
      '## Released migration: 0.6.24',
      '',
      '### fenced first',
      '',
      '```ts',
      'const x = 1;',
      '```',
      '',
      '**Required.** Too late after code fence.',
    ].join('\n');
    expect(() => assertStarterMigrationMarkers(fenceBeforeMarker, CHANGELOG)).toThrow(
      /must start with/,
    );
  });

  test('a With stitchkit X.Y.Z marker naming a version absent from CHANGELOG.md headings is refused even if mentioned in prose', () => {
    const unknownVersion = [
      '# Upgrading',
      '',
      '## Released migration: 0.6.25',
      '',
      '### watch hub reads one request',
      '',
      '**With stitchkit 0.999.0.** Only works on 0.999.0.',
    ].join('\n');
    expect(() => assertStarterMigrationMarkers(unknownVersion, CHANGELOG)).toThrow(
      /references stitchkit 0\.999\.0, which does not exist in CHANGELOG\.md/,
    );
  });

  test('Required, Voluntary and valid With stitchkit X.Y.Z markers pass including unreleased intro before ### and fenced examples', () => {
    const valid = [
      '# Upgrading',
      '',
      '```md',
      '## Released migration: 0.1.0',
      '',
      '### example without marker',
      '',
      'Ignored because it is fenced.',
      '```',
      '',
      '## Unreleased migration: grouped',
      '',
      'Introductory paragraph before subsections.',
      '',
      '### clean env',
      '',
      '**Voluntary.** Nice to have.',
      '',
      '## Released migration: 0.6.25',
      '',
      '### watch hub reads one request',
      '',
      '**With stitchkit 0.126.0.** Required when moving to 0.126.0.',
      '',
      '### config rename',
      '',
      '**Required.** Rename the file before starting.',
    ].join('\n');
    expect(assertStarterMigrationMarkers(valid, CHANGELOG)).toBe(3);
  });
});

describe('starter migration markers on the real guide and across trains', () => {
  /** The migration sections the marker rule judges: every pending one and each release from the rule's first. */
  const judgedSections = (guide: string) =>
    [
      ...guide.matchAll(
        /^## (?:Unreleased migration: .+|Released migration: (\d+\.\d+\.\d+))$/gm,
      ),
    ].filter(
      ([, version]) =>
        version === undefined ||
        comparePreOneVersions(version, STARTER_MIGRATION_MARKERS_SINCE) >= 0,
    ).length;

  test('every real starter UPGRADING.md migration section the rule judges carries a valid marker', async () => {
    const guide = await Bun.file(
      `${import.meta.dir}/../packages/create-stitchkit/UPGRADING.md`,
    ).text();
    const changelog = await Bun.file(`${import.meta.dir}/../CHANGELOG.md`).text();
    expect(assertStarterMigrationMarkers(guide, changelog)).toBeGreaterThanOrEqual(
      judgedSections(guide),
    );
  });

  test('the starter guide as the last commit holds it passes the same rule: a train that leaves the starter untouched is not refused for its history', async () => {
    const show = Bun.spawnSync(
      ['git', 'show', 'HEAD:packages/create-stitchkit/UPGRADING.md'],
      { cwd: `${import.meta.dir}/..`, stdout: 'pipe', stderr: 'pipe' },
    );
    expect(show.exitCode).toBe(0);
    const guide = show.stdout.toString();
    const changelog = await Bun.file(`${import.meta.dir}/../CHANGELOG.md`).text();
    expect(assertStarterMigrationMarkers(guide, changelog)).toBeGreaterThanOrEqual(
      judgedSections(guide),
    );
  });

  test('Train 1 (core + tui) passes with rolled-back unmarked starter UPGRADING.md while Train 2 still checks markers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-plan-train-split-'));
    const put = async (files: Record<string, string>) => {
      for (const [rel, body] of Object.entries(files)) {
        await mkdir(dirname(join(root, rel)), { recursive: true });
        await writeFile(join(root, rel), body);
      }
    };
    const log = (v: string, prev?: string) =>
      `## [${v}] — 2026-11-24\n\n### Added\n\n- Substantive notes for ${v}.\n${prev ? `\n## [${prev}] — 2026-11-20\n\n### Added\n\n- Base release notes.\n` : ''}`;
    const state = (c: string, t: string, s: string, rev: number) =>
      withLockfile({
        'packages/core/package.json': `{"name":"stitchkit","version":"${c}"}`,
        'packages/core/src/index.ts': `export const v = ${rev};\n`,
        'packages/core/tests/fixtures/public-surface.json': '{"stitchkit":["v"]}\n',
        'packages/tui/package.json': `{"name":"stitchkit-tui","version":"${t}","dependencies":{"stitchkit":"workspace:^"}}`,
        'packages/tui/src/index.ts': `export const t = ${rev};\n`,
        'packages/create-stitchkit/package.json': `{"name":"create-stitchkit","version":"${s}"}`,
        'packages/create-stitchkit/template/index.ts': `export const s = ${rev};\n`,
        'CHANGELOG.md': log(c, c === '0.126.0' ? undefined : '0.126.0'),
        'packages/tui/CHANGELOG.md': log(t, t === '0.4.7' ? undefined : '0.4.7'),
        'packages/create-stitchkit/CHANGELOG.md': log(
          s,
          s === '0.6.23' ? undefined : '0.6.23',
        ),
      });
    const guide = (line: string) =>
      `## Released migration: 0.6.23\n\n### watch hub reads one request\n\n${line}\n`;
    try {
      await git(root, ['init', '--quiet']);
      await put({
        ...state('0.126.0', '0.4.7', '0.6.23', 1),
        'docs/guide/getting-started.md': '| `stitchkit` | both | stable | root |\n',
        'docs/guide/upgrading.md': '# Upgrading\n',
        'packages/tui/UPGRADING.md': '# Upgrading\n',
        'packages/create-stitchkit/UPGRADING.md': guide('Unmarked historical note.'),
      });
      await git(root, ['add', '.']);
      const commit =
        '-c user.name=T -c user.email=t@e.com commit --no-gpg-sign --quiet -m base';
      await git(root, commit.split(' '));
      for (const tag of ['v0.126.0', 'stitchkit-tui-v0.4.7', 'create-stitchkit-v0.6.23'])
        await git(root, ['tag', tag]);
      // Train 1: core@0.127.0 + tui@0.5.0 passes with rolled-back unmarked starter UPGRADING.md.
      await put({
        ...state('0.127.0', '0.5.0', '0.6.23', 2),
        'release-train.json':
          '{"schemaVersion":1,"releases":[{"target":"core","version":"0.127.0"},{"target":"tui","version":"0.5.0"}]}',
      });
      await expect(checkWorkingTree(root)).resolves.toBeUndefined();
      // A manifest that gained a dependency the lock never recorded is refused by release:check.
      const tuiManifest = await Bun.file(join(root, 'packages/tui/package.json')).text();
      await put({
        'packages/tui/package.json': tuiManifest.replace(
          '}}',
          '},"devDependencies":{"x":"^1.0.0"}}',
        ),
      });
      await expect(checkWorkingTree(root)).rejects.toThrow(
        /bun\.lock does not record[\s\S]*packages\/tui devDependencies x/,
      );
      await put({ 'packages/tui/package.json': tuiManifest });
      // Train 2: create-stitchkit@0.7.0 enforces the markers on its own section; the unmarked
      // history before the rule stays as it was published.
      const train2 = (line: string) =>
        `## Released migration: 0.7.0\n\n### new step\n\n${line}\n\n${guide('Unmarked historical note.')}`;
      await put({
        ...state('0.127.0', '0.5.0', '0.7.0', 3),
        'release-train.json':
          '{"schemaVersion":1,"releases":[{"target":"create-stitchkit","version":"0.7.0"}]}',
        'packages/create-stitchkit/UPGRADING.md': train2('Unmarked new step.'),
      });
      const opt = { checkStarterLockfile: false };
      await expect(checkWorkingTree(root, opt)).rejects.toThrow(
        /"### new step" must start with/,
      );
      await put({
        'packages/create-stitchkit/UPGRADING.md': train2(
          '**With stitchkit 0.127.0.** Marked.',
        ),
      });
      await expect(checkWorkingTree(root, opt)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
