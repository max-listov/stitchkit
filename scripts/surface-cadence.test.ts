import { describe, expect, test } from 'bun:test';
import {
  assertStableBreakingBudget,
  breakingEntries,
  cadenceSentence,
  maturityTable,
  STABLE_BUDGET_SINCE,
  stableBreakingBudget,
  stableBudgetSentence,
  surfaceCadence,
} from './surface-cadence';

const AGENT_RUNTIME_TERMS = [
  'agent-runtime',
  'AgentRun',
  'AgentMessage',
  'createAgentRuntime',
  'AgentRuntimeStore',
  'inputPolicy',
  'AgentUsage',
  'AgentHistory',
  // The coding tools ship from `stitchkit/agent-runtime/coding-tools` and a
  // consumer of them is a consumer of this surface. Left out, the table read
  // "most recently 0.83.0" in the release that redefined what BOTH of their
  // authorization callbacks are asked about — the same way the application row
  // read "stable" through a break, which is why its own list was widened.
  'createAgentCodingTools',
  'AgentCodingTool',
  // Why a run ended is this surface's vocabulary, and an application branches
  // on it. Left out, the table read "most recently 0.85.0" in the release that
  // split three failures out of `provider_failure` — the third time this list
  // was too narrow for the break it was meant to count.
  'AgentTerminalReason',
  // The conversation reader is this surface's read side, and an application
  // that shows a person their own history is a consumer of it. Left out, the
  // table read "most recently 0.86.0" in the release that made a message page
  // say which of its messages compaction removed — the fourth time this list
  // was too narrow for the break it was meant to count.
  'AgentConversationReader',
  'AgentConversationMessagePage',
] as const;

/**
 * The application kernel's own vocabulary.
 *
 * A second evolving surface deserves the same evidence as the first: the row
 * that says "evolving" is a claim, and the reader deciding whether to build on
 * it should not have to reconstruct the cadence from the changelog by hand.
 */
const APPLICATION_TERMS = [
  'stitchkit/application',
  'createApplication',
  'ManagedResource',
  'managedServerResource',
  'ApplicationConfig',
  'ManagedSchedule',
  'bindProcessSignals',
  'ApplicationSnapshot',
  // The entry is more than the kernel: its admission, credit and journal primitives are public
  // from the same entrypoint, and a consumer of one is a consumer of `stitchkit/application`.
  // Leaving them out let the table read "stable for five minors" in the very release that broke
  // one of them.
  'BoundedAdmission',
  'CreditWindow',
  'DiagnosticJournal',
] as const;

/**
 * A surface that is genuinely stable still has to prove it.
 *
 * The row said "stable" in the release that broke it — the same failure the
 * comment above records for the application kernel, arriving by the other door:
 * there the term list was too narrow, here the surface carried no evidence at
 * all, so nothing could go stale and nothing could fail. One in twenty-eight is
 * a stable surface; the sentence is what keeps that a measurement rather than a
 * claim nobody rechecks.
 */
const OBSERVABILITY_TERMS = [
  'stitchkit/observability',
  'createObservability',
  'ObservabilityDrainReport',
  'ObservabilitySinkStatus',
  'RequestEvent',
  'createBoundedLogger',
  'sanitizePayload',
  'wrapInRequestContext',
] as const;

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
  expect(sentence).toBe('redefined in 21 of the 40 minors since 0.56.2, most recently 0.94.0');
  expect(guide).toContain(`_${sentence}_`);

  const application = cadenceSentence(
    surfaceCadence({ changelog, since: '0.56.2', terms: APPLICATION_TERMS }),
  );
  expect(application).toBe(
    'redefined in 8 of the 40 minors since 0.56.2, most recently 0.95.0',
  );
  expect(guide).toContain(`_${application}_`);

  const observability = cadenceSentence(
    surfaceCadence({ changelog, since: '0.56.2', terms: OBSERVABILITY_TERMS }),
  );
  expect(observability).toBe(
    'redefined in 2 of the 40 minors since 0.56.2, most recently 0.92.0',
  );
  expect(guide).toContain(`_${observability}_`);
});

describe('the breaking budget for stable entrypoints — ADR 0198', () => {
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

  test('one stable-breaking minor in seven days is within the budget', () => {
    const changelog = [
      release('9.3.0', '2026-10-20', STABLE),
      release('9.2.0', '2026-10-13', STABLE),
      release('9.1.0', '2026-10-12', EVOLVING),
    ].join('\n');
    const budget = assertStableBreakingBudget({
      changelog,
      guide: GUIDE,
      version: '9.3.0',
      since: '9.0.0',
    });
    expect(budget.last7).toBe(1);
    expect(budget.last30).toBe(2);
    expect(stableBudgetSentence(budget)).toBe(
      'stable breaking: 2 in 30 days, 1 in 7 days (budget 1)',
    );
  });

  test('a second stable-breaking minor within seven days is refused', () => {
    const changelog = [
      release('9.3.0', '2026-10-19', STABLE),
      release('9.2.0', '2026-10-13', STABLE),
    ].join('\n');
    expect(() =>
      assertStableBreakingBudget({
        changelog,
        guide: GUIDE,
        version: '9.3.0',
        since: '9.0.0',
      }),
    ).toThrow(/2 minors did within 7 days of 2026-10-19 \(9\.3, 9\.2\); the budget is 1/);
  });

  test('evolving entrypoints break freely', () => {
    const changelog = [
      release('9.3.0', '2026-10-13', EVOLVING),
      release('9.2.0', '2026-10-13', STABLE),
    ].join('\n');
    const budget = assertStableBreakingBudget({
      changelog,
      guide: GUIDE,
      version: '9.3.0',
      since: '9.0.0',
    });
    expect(budget.breaksStable).toBe(false);
    expect(budget.last7).toBe(1);
  });

  test('releases before the effective version are not counted', () => {
    const changelog = [
      release('9.3.0', '2026-10-13', STABLE),
      // Written before the rule: no prefix, and a stable break the same week.
      release('9.2.0', '2026-10-12', '- **`createMcpHandler` moved** in stitchkit/tools'),
      release('9.1.0', '2026-10-11', STABLE),
    ].join('\n');
    const budget = assertStableBreakingBudget({
      changelog,
      guide: GUIDE,
      version: '9.3.0',
      since: '9.3.0',
    });
    expect(budget.last7).toBe(1);
    expect(budget.last30).toBe(1);
    // And a release below the effective version is never refused by it.
    expect(() =>
      assertStableBreakingBudget({
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
      assertStableBreakingBudget({
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
      assertStableBreakingBudget({
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
      assertStableBreakingBudget({
        changelog,
        guide: GUIDE,
        version: '9.3.0',
        since: '9.0.0',
      }),
    ).toThrow(/carries no date/);
  });

  test('the budget starts at 0.94.0 and the real changelog reports against it', async () => {
    expect(STABLE_BUDGET_SINCE).toBe('0.94.0');
    const changelog = await Bun.file(`${import.meta.dir}/../CHANGELOG.md`).text();
    const guide = await Bun.file(`${import.meta.dir}/../docs/guide/getting-started.md`).text();
    // 0.93.0 predates the rule, so however much it broke it spends nothing.
    const budget = stableBreakingBudget({ changelog, guide, version: '0.93.0' });
    expect(budget.last7).toBe(0);
    expect(budget.last30).toBe(0);
  });
});
