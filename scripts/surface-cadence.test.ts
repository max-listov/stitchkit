import { describe, expect, test } from 'bun:test';
import {
  assertBreakingReleaseMetadata,
  BREAKING_METADATA_SINCE,
  breakingEntries,
  cadenceSentence,
  maturityTable,
  stableBreakingCadence,
  stableCadenceSentence,
  surfaceCadence,
} from './surface-cadence';

import {
  AGENT_RUNTIME_TERMS,
  APPLICATION_TERMS,
  OBSERVABILITY_TERMS,
} from './surface-cadence-terms';

test('counts a minor once however many patches broke it', () => {
  const changelog = [
    '## [0.3.1] — x',
    '### ⚠️ Breaking changes',
    '- AgentRuntimeStore moved',
    '## [0.3.0] — x',
    '### ⚠️ Breaking changes',
    '- AgentRuntimeStore moved',
    '## [0.2.0] — x',
    '### Added',
    '- something else entirely',
  ].join('\n');
  const cadence = surfaceCadence({ changelog, since: '0.2.0', terms: AGENT_RUNTIME_TERMS });
  expect(cadence.minors).toBe(2);
  expect(cadence.breaking).toBe(1);
  expect(cadence.lastBroken).toBe('0.3.1');
});

test('a breaking section about another surface does not count', () => {
  const changelog = [
    '## [0.3.0] — x',
    '### ⚠️ Breaking changes',
    '- createServer changed its shutdown default',
    '## [0.2.0] — x',
    '### Added',
    '- nothing',
  ].join('\n');
  expect(
    surfaceCadence({ changelog, since: '0.2.0', terms: AGENT_RUNTIME_TERMS }).breaking,
  ).toBe(0);
});

test('the maturity table carries the figure the changelog supports', async () => {
  // The table and the notes cannot drift: this is the only place the sentence
  // is allowed to come from, and a release that breaks the surface again fails
  // here until the table is updated.
  const changelog = await Bun.file(`${import.meta.dir}/../CHANGELOG.md`).text();
  const guide = await Bun.file(`${import.meta.dir}/../docs/guide/getting-started.md`).text();
  const sentence = cadenceSentence(
    surfaceCadence({ changelog, since: '0.56.2', terms: AGENT_RUNTIME_TERMS }),
  );
  expect(sentence).toBe(
    'redefined in 23 of the 54 minors since 0.56.2, most recently 0.105.0',
  );
  expect(guide).toContain(`_${sentence}_`);

  const application = cadenceSentence(
    surfaceCadence({ changelog, since: '0.56.2', terms: APPLICATION_TERMS }),
  );
  expect(application).toBe(
    'redefined in 13 of the 54 minors since 0.56.2, most recently 0.105.0',
  );
  expect(guide).toContain(`_${application}_`);

  const observability = cadenceSentence(
    surfaceCadence({ changelog, since: '0.56.2', terms: OBSERVABILITY_TERMS }),
  );
  expect(observability).toBe(
    'redefined in 2 of the 54 minors since 0.56.2, most recently 0.92.0',
  );
  expect(guide).toContain(`_${observability}_`);
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
