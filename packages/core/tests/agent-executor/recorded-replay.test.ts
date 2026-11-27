/**
 * Live traffic, recorded once and reduced (`fixtures/recorded/manifest.json`
 * names each CLI version), replayed through the drivers by their scripted
 * engines: the dialect the real CLI spoke folds into the turn it was.
 */
import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAcpDriver } from '../../src/agent-executor/acp/v1-driver';
import { createClaudeCliDriver } from '../../src/agent-executor/claude/cli-driver';
import { createCodexDriver } from '../../src/agent-executor/codex/driver';
import { CodexNotificationParams } from '../../src/agent-executor/codex/notifications';
import type { AgentEngineDriver } from '../../src/agent-executor/engine';
import { projectExecutorDeltas } from '../../src/agent-executor/projection';
import type { FakeEngineStep } from '../../src/agent-executor/testing/fake-engine';
import type { ExecutorDelta } from '../../src/agent-executor/vocabulary';

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

async function records(
  file: string,
): Promise<{ type?: string; method?: string; params?: unknown; isReplay?: boolean }[]> {
  return (await readFile(fixture(`recorded/${file}`), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

async function replay(
  make: (fake: string, ambient: Record<string, string | undefined>) => AgentEngineDriver,
  fake: string,
  engine: 'claude-cli' | 'codex' | 'acp',
  steps: FakeEngineStep[],
  answer?: (delta: ExecutorDelta) => { kind: 'deny'; message: string } | undefined,
  env: Record<string, string> = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'stitchkit-replay-'));
  try {
    const scenarioPath = join(root, 'scenario.json');
    await writeFile(scenarioPath, JSON.stringify({ steps }));
    const driver = make(fixture(fake), { PATH: process.env.PATH, HOME: root });
    const session = await driver.open({
      profile: {
        profileId: 'replay',
        engine,
        home: join(root, 'home'),
        env: { FAKE_ENGINE_SCENARIO: scenarioPath, ...env },
      },
      cwd: root,
    });
    const turn = await session.startTurn({
      turnId: 't',
      clientId: crypto.randomUUID(),
      input: [{ type: 'text', text: 'replayed' }],
    });
    const deltas: ExecutorDelta[] = [];
    for await (const delta of turn.deltas) {
      deltas.push(delta);
      const reply = answer?.(delta);
      if (reply !== undefined && delta.type === 'request')
        await turn.respond(delta.interactionId, reply);
    }
    await session.close();
    return deltas;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const claude = (fake: string, ambient: Record<string, string | undefined>) =>
  createClaudeCliDriver({ executable: process.execPath, prefixArgs: [fake], ambient });

function claudeSteps(recorded: Awaited<ReturnType<typeof records>>): FakeEngineStep[] {
  return recorded.flatMap((record): FakeEngineStep[] => {
    if (record.type === 'user' && record.isReplay) return [{ do: 'expect', type: 'user' }];
    const emitted: FakeEngineStep = { do: 'emit', record: JSON.parse(JSON.stringify(record)) };
    return record.type === 'control_request'
      ? [emitted, { do: 'expect', type: 'control_response', subtype: 'success' }]
      : [emitted];
  });
}

test('Claude Code 2.1.330: a recorded text turn folds into its answer', async () => {
  const deltas = await replay(
    claude,
    'fake-claude-engine.ts',
    'claude-cli',
    claudeSteps(await records('claude-2.1.330-text.jsonl')),
  );
  expect(projectExecutorDeltas(deltas)).toEqual([{ type: 'text', text: 'ok' }]);
  expect(deltas.filter((delta) => delta.type === 'error')).toEqual([]);
  expect(deltas.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });
});

test('Claude Code 2.1.330: a recorded Write asked of the host and denied', async () => {
  const deltas = await replay(
    claude,
    'fake-claude-engine.ts',
    'claude-cli',
    claudeSteps(await records('claude-2.1.330-approval-denied.jsonl')),
    () => ({ kind: 'deny', message: 'Not in this replay' }),
  );
  const types = deltas.map((delta) => delta.type);
  expect(types).toEqual(
    expect.arrayContaining([
      'tool-call',
      'request',
      'request-resolved',
      'tool-result',
      'turn-end',
    ]),
  );
  expect(deltas.find((delta) => delta.type === 'tool-result')).toMatchObject({
    toolName: 'Write',
    outcome: 'error',
  });
  expect(deltas.filter((delta) => delta.type === 'error')).toEqual([]);
});

test('Codex 0.162.1: a recorded turn the server failed ends failed, nothing unhandled', async () => {
  const recorded = await records('codex-0.162.1-failed-turn.jsonl');
  const started = CodexNotificationParams['turn/started'].parse(
    recorded.find((record) => record.method === 'turn/started')?.params,
  );
  const deltas = await replay(
    (fake, ambient) =>
      createCodexDriver({ executable: process.execPath, prefixArgs: [fake], ambient }),
    'fake-codex-engine.ts',
    'codex',
    recorded.map(
      (record): FakeEngineStep => ({ do: 'emit', record: JSON.parse(JSON.stringify(record)) }),
    ),
    undefined,
    {
      FAKE_CODEX_THREAD_EXTRA: JSON.stringify({ id: started.threadId }),
      FAKE_CODEX_TURN_ID: started.turn.id,
    },
  );
  expect(
    deltas
      .filter((delta) => delta.type === 'error')
      .map((delta) => delta.type === 'error' && delta.kind),
  ).toEqual(['restartRecommended']);
  expect(deltas.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'failed' });
});

const acp = (fake: string, ambient: Record<string, string | undefined>) =>
  createAcpDriver({ executable: process.execPath, args: [fake], ambient });

test('agy 1.5.14: a recorded text turn folds into its answer over ACP v1', async () => {
  const recorded = await records('agy-1.5.14-text.jsonl');
  const deltas = await replay(
    acp,
    'fake-acp-agent.ts',
    'acp',
    recorded.map(
      (record): FakeEngineStep => ({ do: 'emit', record: JSON.parse(JSON.stringify(record)) }),
    ),
  );
  expect(projectExecutorDeltas(deltas).filter((part) => part.type === 'text')).toEqual([
    { type: 'text', text: 'ok' },
  ]);
  expect(deltas.filter((delta) => delta.type === 'error')).toEqual([]);
  expect(deltas.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });
});

test('agy 1.5.14: a recorded cancelled turn ends interrupted', async () => {
  const recorded = await records('agy-1.5.14-cancelled.jsonl');
  const deltas = await replay(
    acp,
    'fake-acp-agent.ts',
    'acp',
    recorded.map(
      (record): FakeEngineStep => ({ do: 'emit', record: JSON.parse(JSON.stringify(record)) }),
    ),
  );
  expect(deltas.filter((delta) => delta.type === 'error')).toEqual([]);
  expect(deltas.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'interrupted' });
});
