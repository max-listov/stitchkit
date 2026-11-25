import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
// @ts-expect-error — the manifest is plain ESM shared by the build and the gates.
import { ENTRYPOINTS as RAW_ENTRYPOINTS } from '../packages/core/entrypoints.mjs';
import {
  CADENCE_EXCLUDED_SURFACES,
  cadenceRowsInGuide,
  cadenceSurfaces,
  refreshCadence,
  shippedInGuide,
  surfaceCadenceSentence,
} from './release-derived';
import {
  assertBreakingReleaseMetadata,
  BREAKING_METADATA_SINCE,
  breakingEntries,
  matchesSurfaceFamily,
  maturityTable,
  stableBreakingCadence,
  stableCadenceSentence,
  surfaceCadence,
} from './surface-cadence';

const ENTRYPOINTS = z.array(z.looseObject({ subpath: z.string() })).parse(RAW_ENTRYPOINTS);

const SYNTHETIC_GUIDE = [
  '| Import | Use in | Maturity | Holds |',
  '|--------|--------|----------|-------|',
  '| `stitchkit` | browser **and** server | stable | root |',
  '| `stitchkit/tools` | server | stable | tools |',
  '| `stitchkit/agent-runtime` | server | evolving | runtime |',
  '| `stitchkit/agent-runtime/coding-tools` | server | evolving | coding tools |',
].join('\n');

const SYNTHETIC_KNOWN = maturityTable(SYNTHETIC_GUIDE);

test('a surface shipped after the floor counts from its release, and that release does not redefine it', () => {
  const changelog = [
    '## [0.128.0] — 2026-12-01',
    '### ⚠️ Breaking changes',
    '- `stitchkit/agent-runtime` — a later break',
    '## [0.127.0] — 2026-11-25',
    '### ⚠️ Breaking changes',
    '- `stitchkit/agent-runtime` — moved in while it shipped',
    '## [0.126.0] — 2026-11-21',
    '### Added',
    '- something else entirely',
  ].join('\n');
  const cadence = surfaceCadence({
    changelog,
    surface: 'stitchkit/agent-runtime',
    known: SYNTHETIC_KNOWN,
    shipped: '0.127.0',
  });
  expect(cadence).toEqual({ since: '0.127.0', minors: 2, breaking: 1, lastBroken: '0.128.0' });
  // A surface that shipped before the floor counts from the floor.
  expect(
    surfaceCadence({
      changelog,
      surface: 'stitchkit/agent-runtime',
      known: SYNTHETIC_KNOWN,
      shipped: '0.69.0',
    }),
  ).toEqual({ since: BREAKING_METADATA_SINCE, minors: 3, breaking: 2, lastBroken: '0.128.0' });
  // The row keeps the release that shipped it once `prepare` wrote it.
  const guide =
    '| `stitchkit/agent-runtime` | server | evolving<br>_redefined in 0 of the 1 minor since 0.127.0_ | x |\n';
  expect(shippedInGuide(guide, 'stitchkit/agent-runtime')).toBe('0.127.0');
  expect(refreshCadence(guide, changelog)).toContain(
    '_redefined in 1 of the 2 minors since 0.127.0, most recently 0.128.0_',
  );
});

test('counts a minor once however many patches broke it', () => {
  const changelog = [
    '## [0.96.1] — 2026-10-05',
    '### ⚠️ Breaking changes',
    '- `stitchkit/agent-runtime` — AgentRuntimeStore moved',
    '## [0.96.0] — 2026-10-04',
    '### ⚠️ Breaking changes',
    '- `stitchkit/agent-runtime` — AgentRuntimeStore moved',
    '## [0.95.0] — 2026-10-01',
    '### Added',
    '- something else entirely',
  ].join('\n');
  const cadence = surfaceCadence({
    changelog,
    surface: 'stitchkit/agent-runtime',
    known: SYNTHETIC_KNOWN,
  });
  expect(cadence.since).toBe(BREAKING_METADATA_SINCE);
  expect(cadence.minors).toBe(2);
  expect(cadence.breaking).toBe(1);
  expect(cadence.lastBroken).toBe('0.96.1');
});

test('family rule: subpath counts for its parent, prose mentions and pre-0.94.0 do not, subpaths do not count for root stitchkit', () => {
  const changelog = [
    '## [0.97.0] — 2026-10-10',
    '### ⚠️ Breaking changes',
    '- `stitchkit/agent-runtime/coding-tools` — authorization callback shape changed',
    '## [0.96.0] — 2026-10-08',
    '### ⚠️ Breaking changes',
    '- `stitchkit/tools` — mentions `createAgentRuntime` in the body, not in the leading entrypoint',
    '## [0.95.0] — 2026-10-06',
    '### ⚠️ Breaking changes',
    '- `stitchkit` — root client retry option changed',
    '## [0.93.0] — 2026-09-20',
    '### ⚠️ Breaking changes',
    '- `stitchkit/agent-runtime` — predates BREAKING_METADATA_SINCE (0.94.0)',
  ].join('\n');

  // Subpath leading `stitchkit/agent-runtime/coding-tools` counts for `stitchkit/agent-runtime`,
  // while `stitchkit/tools` mentioning `createAgentRuntime` in its body and 0.93.0 do NOT.
  const runtimeCadence = surfaceCadence({
    changelog,
    surface: 'stitchkit/agent-runtime',
    known: SYNTHETIC_KNOWN,
  });
  expect(runtimeCadence.minors).toBe(3);
  expect(runtimeCadence.breaking).toBe(1);
  expect(runtimeCadence.lastBroken).toBe('0.97.0');

  // Root `stitchkit` counts ONLY `stitchkit` itself (0.95.0), never subpaths (`stitchkit/tools`, `stitchkit/agent-runtime/*`).
  const rootCadence = surfaceCadence({
    changelog,
    surface: 'stitchkit',
    known: SYNTHETIC_KNOWN,
  });
  expect(rootCadence.minors).toBe(3);
  expect(rootCadence.breaking).toBe(1);
  expect(rootCadence.lastBroken).toBe('0.95.0');

  expect(matchesSurfaceFamily('stitchkit', 'stitchkit')).toBe(true);
  expect(matchesSurfaceFamily('stitchkit', 'stitchkit/tools')).toBe(false);
  expect(
    matchesSurfaceFamily('stitchkit/agent-runtime', 'stitchkit/agent-runtime/coding-tools'),
  ).toBe(true);
  expect(
    matchesSurfaceFamily('stitchkit/agent-runtime', 'stitchkit/agent-runtime-extra'),
  ).toBe(false);
});

test('the maturity table carries a cadence row for every core entrypoint and matches the changelog', async () => {
  // The table and the notes cannot drift: the sentence comes only from the
  // changelog, and `prepare` writes it at every release (`release-derived.ts`).
  const changelog = await Bun.file(`${import.meta.dir}/../CHANGELOG.md`).text();
  const guide = await Bun.file(`${import.meta.dir}/../docs/guide/getting-started.md`).text();
  const known = maturityTable(guide);
  const expectedCoreEntries = ENTRYPOINTS.map((entry) =>
    entry.subpath === '.' ? 'stitchkit' : `stitchkit/${entry.subpath.slice(2)}`,
  ).sort();

  // Completeness: the set of rows carrying a cadence figure equals `ENTRYPOINTS` dynamically.
  const withCadence = cadenceRowsInGuide(guide).sort();
  expect(withCadence).toEqual(expectedCoreEntries);

  // `stitchkit-tui` is the only declared maturity-table row without a core cadence figure.
  const withoutCadence = [...known.keys()]
    .filter((name) => !withCadence.includes(name))
    .sort();
  expect(withoutCadence).toEqual([...CADENCE_EXCLUDED_SURFACES].sort());

  // Negative control: an entrypoint declared without a cadence row fails completeness. A row
  // dated by the floor is restored as it was; a later `since` is the record of its release.
  const floorDated = cadenceSurfaces(guide).find(
    (surface) => surface !== 'stitchkit' && shippedInGuide(guide, surface) === undefined,
  );
  if (floorDated === undefined) throw new Error('expected a row dated by the floor');
  const missingOne = guide.replace(
    new RegExp(`(\\| \`${floorDated}\` \\|[^|\\n]*\\|[^|\\n]*)<br>_redefined in [^_]+_`),
    '$1',
  );
  expect(missingOne).not.toBe(guide);
  expect(cadenceRowsInGuide(missingOne).sort()).not.toEqual(expectedCoreEntries);
  expect(refreshCadence(missingOne, changelog)).toBe(guide);

  for (const surface of cadenceSurfaces(guide)) {
    const shipped = shippedInGuide(guide, surface);
    const sentence = surfaceCadenceSentence(changelog, surface, known, shipped);
    expect(sentence).toMatch(
      new RegExp(
        `^redefined in \\d+ of the \\d+ minors? since ${(shipped ?? '0.94.0').replaceAll('.', '\\.')}`,
      ),
    );
    expect(guide).toContain(`_${sentence}_`);
  }
  // `prepare` writes exactly these rows: the guide is already what it would write.
  expect(refreshCadence(guide, changelog)).toBe(guide);
});

describe('breaking metadata and observed cadence — ADR 0204', () => {
  const GUIDE = [
    '| Import | Use in | Maturity | Holds |',
    '|--------|--------|----------|-------|',
    '| `stitchkit/tools` | server | stable | tools |',
    '| `stitchkit/observability` | server | stable<br>_redefined in 2 of 3 minors_ | events |',
    '| `stitchkit/live` | browser **and** server | evolving | watched reads |',
  ].join('\n');
  const BREAKING = '### \u26a0\ufe0f Breaking changes';

  const release = (version: string, date: string, ...entries: string[]) =>
    [
      `## [${version}] — ${date}`,
      '',
      ...(entries.length > 0
        ? [BREAKING, '', ...entries, '', '**Who must act:** someone.', '']
        : ['### Added', '', '- a thing', '']),
    ].join('\n');
  const STABLE = '- `stitchkit/tools` — **a tool moved**, because a reason.\n  → ADR 0198';
  const EVOLVING = '- `stitchkit/live` — **a watched read moved**.';

  test('reads stable and evolving out of the maturity table, and only from there', () => {
    const table = maturityTable(GUIDE);
    expect(table.get('stitchkit/tools')).toBe('stable');
    expect(table.get('stitchkit/observability')).toBe('stable');
    expect(table.get('stitchkit/live')).toBe('evolving');
    expect(table.has('stitchkit/react')).toBe(false);
  });

  test('the real maturity table classifies every row it lists', async () => {
    const guide = await Bun.file(`${import.meta.dir}/../docs/guide/getting-started.md`).text();
    const rows = [...guide.matchAll(/^\| `(stitchkit[\w/-]*)` \|/gm)].map((row) => row[1]);
    const table = maturityTable(guide);
    expect(rows.filter((name) => name === undefined || !table.has(name))).toEqual([]);
    expect(table.get('stitchkit/contract')).toBe('stable');
    expect(table.get('stitchkit/agent-runtime')).toBe('evolving');
  });

  test('entrypoints listed with spaces between them all count for the stable cadence', () => {
    const entry =
      '- `stitchkit/live` `stitchkit/tools` `stitchkit/observability` a timer option follows the rule. → ADR 0198';
    const changelog = [
      release('0.95.0', '2026-01-10', entry),
      release('0.94.0', '2026-01-01'),
    ].join('\n');
    expect(
      breakingEntries(`${BREAKING}\n${entry}`, maturityTable(GUIDE)).map(
        (found) => found.entrypoints,
      ),
    ).toEqual([['stitchkit/live', 'stitchkit/tools', 'stitchkit/observability']]);
    const cadence = stableBreakingCadence({ changelog, guide: GUIDE, version: '0.95.0' });
    expect(cadence.breaksStable).toBe(true);
    expect(cadence.last30).toBe(1);
  });

  test('an entry leads with one or several entrypoints, and a symbol is not one', () => {
    const table = maturityTable(GUIDE);
    const entries = breakingEntries(
      [
        BREAKING,
        '- **`stitchkit/tools`, `stitchkit/live` — both moved**',
        '- `stitchkit/tools` and `stitchkit/observability`: moved',
        '- **`createMcpHandler` no longer accepts `foo`**',
        '  - `stitchkit/live` nested, part of the entry above',
        '```ts',
        '- `stitchkit/live` inside a fence is an example',
        '```',
        '**Who must act:** someone.',
      ].join('\n'),
      table,
    );
    expect(entries.map((entry) => entry.entrypoints)).toEqual([
      ['stitchkit/tools', 'stitchkit/live'],
      ['stitchkit/tools', 'stitchkit/observability'],
      [],
    ]);
  });

  test('release cadence counts dated stable-breaking minors', () => {
    const changelog = [
      release('9.3.0', '2026-10-20', STABLE),
      release('9.2.0', '2026-10-13', STABLE),
      release('9.1.0', '2026-10-12', EVOLVING),
    ].join('\n');
    const cadence = assertBreakingReleaseMetadata({
      changelog,
      guide: GUIDE,
      version: '9.3.0',
      since: '9.0.0',
    });
    expect(cadence.last7).toBe(1);
    expect(cadence.last30).toBe(2);
    expect(stableCadenceSentence(cadence)).toBe('stable breaking: 2 in 30 days, 1 in 7 days');
  });

  test('multiple stable-breaking minors in one week are allowed and reported', () => {
    const changelog = [
      release('9.3.0', '2026-10-19', STABLE),
      release('9.2.0', '2026-10-13', STABLE),
    ].join('\n');
    const cadence = assertBreakingReleaseMetadata({
      changelog,
      guide: GUIDE,
      version: '9.3.0',
      since: '9.0.0',
    });
    expect(cadence.last7).toBe(2);
    expect(cadence.counted).toEqual(['9.3', '9.2']);
  });

  test('evolving entrypoints break freely', () => {
    const changelog = [
      release('9.3.0', '2026-10-13', EVOLVING),
      release('9.2.0', '2026-10-13', STABLE),
    ].join('\n');
    const cadence = assertBreakingReleaseMetadata({
      changelog,
      guide: GUIDE,
      version: '9.3.0',
      since: '9.0.0',
    });
    expect(cadence.breaksStable).toBe(false);
    expect(cadence.last7).toBe(1);
  });

  test('releases before the effective version are not counted', () => {
    const changelog = [
      release('9.3.0', '2026-10-13', STABLE),
      // Written before the rule: no prefix, and a stable break the same week.
      release('9.2.0', '2026-10-12', '- **`createMcpHandler` moved** in stitchkit/tools'),
      release('9.1.0', '2026-10-11', STABLE),
    ].join('\n');
    const cadence = assertBreakingReleaseMetadata({
      changelog,
      guide: GUIDE,
      version: '9.3.0',
      since: '9.3.0',
    });
    expect(cadence.last7).toBe(1);
    expect(cadence.last30).toBe(1);
    // And a release below the effective version is never refused by it.
    expect(() =>
      assertBreakingReleaseMetadata({
        changelog,
        guide: GUIDE,
        version: '9.2.0',
        since: '9.3.0',
      }),
    ).not.toThrow();
  });

  test('a breaking entry that does not lead with its entrypoint is refused', () => {
    const changelog = release('9.3.0', '2026-10-13', '- **`createMcpHandler` moved**');
    expect(() =>
      assertBreakingReleaseMetadata({
        changelog,
        guide: GUIDE,
        version: '9.3.0',
        since: '9.0.0',
      }),
    ).toThrow(/does not start with the entrypoint it breaks/);
  });

  test('a stable break without an ADR is refused', () => {
    const changelog = release('9.3.0', '2026-10-13', '- `stitchkit/tools` — **moved**');
    expect(() =>
      assertBreakingReleaseMetadata({
        changelog,
        guide: GUIDE,
        version: '9.3.0',
        since: '9.0.0',
      }),
    ).toThrow(/must cite the ADR/);
  });

  test('a stable break with an undated heading is refused, not waved through', () => {
    const changelog = release('9.3.0', 'x', STABLE);
    expect(() =>
      assertBreakingReleaseMetadata({
        changelog,
        guide: GUIDE,
        version: '9.3.0',
        since: '9.0.0',
      }),
    ).toThrow(/carries no date/);
  });

  test('metadata classification starts at 0.94.0', async () => {
    expect(BREAKING_METADATA_SINCE).toBe('0.94.0');
    const changelog = await Bun.file(`${import.meta.dir}/../CHANGELOG.md`).text();
    const guide = await Bun.file(`${import.meta.dir}/../docs/guide/getting-started.md`).text();
    // 0.93.0 predates the rule, so its breaks are not classified by the new metadata.
    const cadence = stableBreakingCadence({ changelog, guide, version: '0.93.0' });
    expect(cadence.last7).toBe(0);
    expect(cadence.last30).toBe(0);
  });
});
