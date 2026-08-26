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
  expect(sentence).toBe('redefined in 8 of the 10 minors since 0.56.2, most recently 0.65.0');
  expect(guide).toContain(`_${sentence}_`);
});
