/** The Codex driver against a scripted app-server, through the conformance kit. */
import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexDriver } from '../../src/agent-executor/codex/driver';
import { codexFakeScenarios } from '../../src/agent-executor/codex/scenarios';
import type { AgentEngineTurn } from '../../src/agent-executor/engine';
import { runAgentEngineConformance } from '../../src/agent-executor/testing/conformance';
import { recordedLines } from '../support/engine-driver-harness';

const FAKE = fileURLToPath(new URL('../fixtures/fake-codex-engine.ts', import.meta.url));

async function harness(scenario: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'stitchkit-codex-fake-'));
  const scenarioPath = join(root, 'scenario.json');
  await writeFile(scenarioPath, JSON.stringify(scenario));
  const profile = {
    profileId: 'fake',
    engine: 'codex' as const,
    home: join(root, 'home'),
    env: { FAKE_ENGINE_SCENARIO: scenarioPath },
  };
  return {
    root,
    profile,
    driver: createCodexDriver({
      executable: process.execPath,
      prefixArgs: [FAKE],
      ambient: { PATH: process.env.PATH, HOME: root },
    }),
  };
}

test('the Codex driver passes the engine conformance kit', async () => {
  await runAgentEngineConformance({
    scenarios: codexFakeScenarios,
    async open(scenario) {
      const { root, profile, driver } = await harness(scenario);
      return {
        driver,
        profile,
        cwd: root,
        async inputs() {
          const text = await readFile(join(profile.home, 'client-ids.jsonl'), 'utf8').catch(
            () => '',
          );
          return text.trim().split('\n').filter(Boolean).length;
        },
        async answered(request) {
          return (await recordedLines(join(profile.home, 'responses.jsonl'))).some(
            (line) => Reflect.get(Object(line), 'id') === request.interactionId,
          );
        },
        cleanup: () => rm(root, { recursive: true, force: true }),
      };
    },
  });
  expect(true).toBe(true);
}, 60_000);

test('a server request the driver does not know is refused at once, so the turn does not hang', async () => {
  const { root, profile, driver } = await harness({
    steps: [
      { do: 'emit', record: { id: 'server-9', method: 'item/tool/call', params: {} } },
      { do: 'expect', type: 'response' },
      {
        do: 'emit',
        record: {
          method: 'turn/completed',
          params: {
            threadId: 'fake-thread',
            turn: { id: 'fake-turn', status: 'completed', items: [] },
          },
        },
      },
    ],
  });
  try {
    const session = await driver.open({ profile, cwd: root });
    const turn = await session.startTurn({
      turnId: 't',
      clientId: crypto.randomUUID(),
      input: [{ type: 'text', text: 'hi' }],
    });
    const kinds: string[] = [];
    for await (const delta of turn.deltas)
      kinds.push(delta.type === 'error' ? `error:${delta.kind}` : delta.type);
    expect(kinds).toEqual(['error:unhandled', 'turn-end']);
    await session.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an approval denied is declined and the turn goes on; one the interrupt answers is cancelled', async () => {
  const answered = async (
    scenario: unknown,
    act: (turn: AgentEngineTurn, interactionId: string) => Promise<void>,
  ) => {
    const { root, profile, driver } = await harness(scenario);
    try {
      const session = await driver.open({ profile, cwd: root });
      const turn = await session.startTurn({
        turnId: 't',
        clientId: crypto.randomUUID(),
        input: [{ type: 'text', text: 'hi' }],
      });
      for await (const delta of turn.deltas)
        if (delta.type === 'request') await act(turn, delta.interactionId);
      await session.close();
      return (await readFile(join(profile.home, 'responses.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };
  expect(
    await answered(codexFakeScenarios.approval(), (turn, id) =>
      turn.respond(id, { kind: 'deny', message: 'no' }),
    ),
  ).toEqual([{ id: 'server-1', result: { decision: 'decline' } }]);
  expect(
    await answered(codexFakeScenarios.interruptDuringApproval(), (turn) => turn.interrupt()),
  ).toEqual([{ id: 'server-1', result: { decision: 'cancel' } }]);
});

test('limits are read from the app-server for a subscription profile', async () => {
  const { root, profile, driver } = await harness({ steps: [] });
  try {
    expect(await driver.status(profile)).toMatchObject({
      login: { state: 'signed-in' },
      effectiveCredential: 'subscription',
      planLimits: {
        answer: 'known',
        windows: [{ name: 'limit:10080m', usedPercent: 12, windowDurationMins: 10080 }],
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a new thread carries the approval policy, sandbox and model the driver was given', async () => {
  const { root, profile } = await harness({ steps: [] });
  try {
    const driver = createCodexDriver({
      executable: process.execPath,
      prefixArgs: [FAKE],
      ambient: { PATH: process.env.PATH, HOME: root },
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      model: 'model-under-test',
    });
    const session = await driver.open({ profile, cwd: root });
    await session.close();
    const [params] = (await readFile(join(profile.home, 'thread-start.jsonl'), 'utf8'))
      .trim()
      .split('\n');
    expect(JSON.parse(params ?? '{}')).toMatchObject({
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      model: 'model-under-test',
      cwd: root,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
