import { expect, test } from 'bun:test';
import { cadenceSentence, surfaceCadence } from './surface-cadence';

const AGENT_RUNTIME_TERMS = [
  'agent-runtime',
  'AgentRun',
  'AgentMessage',
  'createAgentRuntime',
  'AgentRuntimeStore',
  'inputPolicy',
  'AgentUsage',
  'AgentHistory',
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
  expect(sentence).toBe('redefined in 12 of the 28 minors since 0.56.2, most recently 0.83.0');
  expect(guide).toContain(`_${sentence}_`);

  const application = cadenceSentence(
    surfaceCadence({ changelog, since: '0.56.2', terms: APPLICATION_TERMS }),
  );
  expect(application).toBe(
    'redefined in 7 of the 28 minors since 0.56.2, most recently 0.83.0',
  );
  expect(guide).toContain(`_${application}_`);

  const observability = cadenceSentence(
    surfaceCadence({ changelog, since: '0.56.2', terms: OBSERVABILITY_TERMS }),
  );
  expect(observability).toBe(
    'redefined in 1 of the 28 minors since 0.56.2, most recently 0.83.0',
  );
  expect(guide).toContain(`_${observability}_`);
});
