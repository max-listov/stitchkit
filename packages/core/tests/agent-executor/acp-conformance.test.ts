/** The ACP v1 driver against a scripted agent, through the conformance kit and the parts ACP adds. */
import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acpFakeScenarios } from '../../src/agent-executor/acp/scenarios';
import { type AcpDriverConfig, createAcpDriver } from '../../src/agent-executor/acp/v1-driver';
import { runAgentEngineConformance } from '../../src/agent-executor/testing/conformance';
import type { FakeEngineStep } from '../../src/agent-executor/testing/fake-engine';
import type { ExecutorDelta } from '../../src/agent-executor/vocabulary';
import { reapAfterEachTest, trackPidFile } from '../support/process-reaper';

reapAfterEachTest();

const FAKE = fileURLToPath(new URL('../fixtures/fake-acp-agent.ts', import.meta.url));

async function harness(
  steps: FakeEngineStep[],
  options: { agent?: Record<string, string>; driver?: Partial<AcpDriverConfig> } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'stitchkit-acp-fake-'));
  const scenarioPath = join(root, 'scenario.json');
  await writeFile(scenarioPath, JSON.stringify({ steps }));
  const home = join(root, 'home');
  const profile = {
    profileId: 'fake',
    engine: 'acp' as const,
    home,
    env: { FAKE_ENGINE_SCENARIO: scenarioPath, FAKE_ACP_HOME: home, ...options.agent },
  };
  const driver = createAcpDriver({
    executable: process.execPath,
    args: [FAKE],
    ambient: { PATH: process.env.PATH, HOME: root },
    ...options.driver,
  });
  const lines = async (file: string) =>
    (await readFile(join(home, file), 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return {
    root,
    profile,
    driver,
    lines,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

const answer = (stopReason = 'end_turn'): FakeEngineStep => ({
  do: 'emit',
  record: { answerPrompt: { stopReason } },
});
const update = (value: Record<string, unknown>): FakeEngineStep => ({
  do: 'emit',
  record: {
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: 'fake-session', update: JSON.parse(JSON.stringify(value)) },
  },
});

async function drain(turn: { deltas: AsyncIterable<ExecutorDelta> }) {
  const deltas: ExecutorDelta[] = [];
  for await (const delta of turn.deltas) deltas.push(delta);
  return deltas;
}

const text = (value: string) => [{ type: 'text' as const, text: value }];

test('the ACP driver passes the engine conformance kit', async () => {
  await runAgentEngineConformance({
    scenarios: acpFakeScenarios,
    async open(scenario) {
      const fake = await harness(scenario.steps);
      return {
        driver: fake.driver,
        profile: fake.profile,
        cwd: fake.root,
        inputs: async () => (await fake.lines('prompts.jsonl')).length,
        answered: async (request) =>
          (await fake.lines('responses.jsonl')).some(
            (line) => Reflect.get(Object(line), 'id') === request.interactionId,
          ),
        cleanup: fake.cleanup,
      };
    },
  });
  expect(true).toBe(true);
}, 60_000);

test('two profiles with two homes run their agents under two HOMEs, never the executor’s', async () => {
  const fake = await harness([answer()]);
  try {
    const homes: unknown[] = [];
    for (const name of ['work', 'personal']) {
      const home = join(fake.root, name);
      const session = await fake.driver.open({
        profile: { ...fake.profile, profileId: name, home, env: { FAKE_ACP_HOME: home } },
        cwd: fake.root,
      });
      await session.close();
      const [seen] = (await readFile(join(home, 'home.jsonl'), 'utf8')).trim().split('\n');
      homes.push(JSON.parse(seen ?? '{}'));
    }
    expect(homes).toEqual([
      { HOME: join(fake.root, 'work') },
      { HOME: join(fake.root, 'personal') },
    ]);
  } finally {
    await fake.cleanup();
  }
});

test('info tells an agent that offers no models from a probe that failed', async () => {
  // The probe runs the agent under the ambient HOME, and the fake is a Bun script that keeps
  // its transpiler cache in `$HOME/.bun`: a scratch HOME, never the shared temporary directory.
  const home = await mkdtemp(join(tmpdir(), 'stitchkit-acp-info-'));
  const info = (flag: string) =>
    createAcpDriver({
      executable: process.execPath,
      args: [FAKE, flag],
      ambient: { PATH: process.env.PATH, HOME: home },
    }).info();
  try {
    expect((await info('--offer-no-models')).models).toEqual({ answer: 'listed', ids: [] });
    expect((await info('--refuse-session-new')).models).toEqual({
      answer: 'failed',
      error: 'probe refused',
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('handshake accepts protocolVersion 2 with v1 shape and refuses ACP v2 carrying info', async () => {
  // Real ACP v1 agents may report protocolVersion >= 2 while speaking the v1 initialize shape.
  const v1Higher = await harness([], { agent: { FAKE_ACP_PROTOCOL: '2' } });
  try {
    const session = await v1Higher.driver.open({
      profile: v1Higher.profile,
      cwd: v1Higher.root,
    });
    await session.close();
  } finally {
    await v1Higher.cleanup();
  }

  // Genuine ACP v2 announces itself via `"info"` in the initialize response and must be refused.
  const v2Root = await mkdtemp(join(tmpdir(), 'stitchkit-acp-v2-'));
  const v2PidFile = join(v2Root, 'v2.pid');
  trackPidFile(v2PidFile);
  try {
    const scriptPath = join(v2Root, 'v2-agent.mjs');
    await writeFile(
      scriptPath,
      [
        `import { writeFileSync } from 'node:fs';`,
        `import { createInterface } from 'node:readline';`,
        `writeFileSync(${JSON.stringify(v2PidFile)}, String(process.pid));`,
        'for await (const line of createInterface({ input: process.stdin })) {',
        '  const msg = JSON.parse(line);',
        `  if (msg.method === 'initialize') {`,
        '    process.stdout.write(JSON.stringify({',
        `      jsonrpc: '2.0',`,
        '      id: msg.id,',
        `      result: { protocolVersion: 2, info: { name: 'v2-agent', version: '2.0.0' }, capabilities: {} },`,
        `    }) + '\\n');`,
        '  }',
        '}',
      ].join('\n'),
    );
    const v2Driver = createAcpDriver({
      executable: process.execPath,
      args: [scriptPath],
      ambient: { PATH: process.env.PATH, HOME: v2Root },
    });
    await expect(
      v2Driver.open({
        profile: { profileId: 'v2', engine: 'acp', home: join(v2Root, 'home') },
        cwd: v2Root,
      }),
    ).rejects.toThrow(/protocol v2.*info/i);
  } finally {
    await rm(v2Root, { recursive: true, force: true });
  }

  // Negative control: protocolVersion < 1 is refused.
  const zero = await harness([], { agent: { FAKE_ACP_PROTOCOL: '0' } });
  try {
    await expect(zero.driver.open({ profile: zero.profile, cwd: zero.root })).rejects.toThrow(
      'requires protocol >= 1',
    );
  } finally {
    await zero.cleanup();
  }
});

test('an interrupt answers a permission request still pending with cancelled', async () => {
  const fake = await harness([
    {
      do: 'emit',
      record: {
        jsonrpc: '2.0',
        id: 'agent-7',
        method: 'session/request_permission',
        params: {
          sessionId: 'fake-session',
          toolCall: { toolCallId: 'c' },
          options: [{ optionId: 'yes', kind: 'allow_once' }],
        },
      },
    },
    { do: 'expect', type: 'session/cancel' },
    { do: 'expect', type: 'response' },
    answer('cancelled'),
  ]);
  try {
    const session = await fake.driver.open({ profile: fake.profile, cwd: fake.root });
    const turn = await session.startTurn({
      turnId: 't',
      clientId: crypto.randomUUID(),
      input: text('hi'),
    });
    const outcomes: string[] = [];
    for await (const delta of turn.deltas) {
      if (delta.type === 'request') await turn.interrupt();
      if (delta.type === 'turn-end') outcomes.push(delta.outcome);
    }
    expect(outcomes).toEqual(['interrupted']);
    await session.close();
  } finally {
    await fake.cleanup();
  }
});

test('model, thought level and mode are set by category, in order, and a value not offered is refused', async () => {
  const fake = await harness([], {
    driver: { model: 'small', thoughtLevel: 'low', mode: 'plan', mcpServers: [] },
  });
  try {
    const session = await fake.driver.open({ profile: fake.profile, cwd: fake.root });
    const set = (await fake.lines('methods.jsonl')).filter(
      (entry) => entry.method === 'session/set_config_option',
    );
    expect(set.map((entry) => [entry.params.configId, entry.params.value])).toEqual([
      ['model', 'small'],
      ['thought', 'low'],
      ['mode', 'plan'],
    ]);
    expect(session.configOptions.find((option) => option.id === 'mode')?.currentValue).toBe(
      'plan',
    );
    await expect(session.setConfigOption('thought_level', 'high')).rejects.toThrow(
      'has no value high (offered: low)',
    );
    await session.close();
  } finally {
    await fake.cleanup();
  }
  const refused = await harness([], { driver: { model: 'model-not-offered' } });
  try {
    await expect(
      refused.driver.open({ profile: refused.profile, cwd: refused.root }),
    ).rejects.toThrow('has no value model-not-offered (offered: small, large)');
  } finally {
    await refused.cleanup();
  }
});

test('the session keeps the agent options, title and commands it reports, and info lists the models', async () => {
  const fake = await harness([
    update({ sessionUpdate: 'session_info_update', title: 'A titled session' }),
    update({
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'compact' }],
    }),
    update({ sessionUpdate: 'usage_update', used: 1200, size: 1_048_576 }),
    answer(),
  ]);
  try {
    expect((await fake.driver.info()).models).toEqual({
      answer: 'listed',
      ids: ['small', 'large'],
    });
    const session = await fake.driver.open({ profile: fake.profile, cwd: fake.root });
    const deltas = await drain(
      await session.startTurn({
        turnId: 't',
        clientId: crypto.randomUUID(),
        input: text('hi'),
      }),
    );
    expect(session.title).toBe('A titled session');
    expect(session.commands).toEqual(['compact']);
    expect(deltas.filter((delta) => delta.type === 'context-usage')).toMatchObject([
      { usedTokens: 1200, windowTokens: 1_048_576 },
    ]);
    expect(deltas.filter((delta) => delta.type === 'error')).toEqual([]);
    await session.setConfigOption('model', 'small');
    expect(session.configOptions.find((option) => option.id === 'thought')?.options).toEqual([
      { value: 'low', name: 'Low' },
    ]);
    await session.close();
  } finally {
    await fake.cleanup();
  }
});

test('an image goes as an image block when the agent takes images, and is refused otherwise', async () => {
  const picture = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const image = [
    { type: 'text' as const, text: 'look' },
    { type: 'file' as const, mediaType: 'image/png', reference: 'files/picture.png' },
  ];
  const fake = await harness([answer()], {
    agent: { FAKE_ACP_IMAGE: '1' },
    driver: { resolveFile: async () => picture, maxImageBytes: 64 },
  });
  try {
    const session = await fake.driver.open({ profile: fake.profile, cwd: fake.root });
    await drain(
      await session.startTurn({ turnId: 't', clientId: crypto.randomUUID(), input: image }),
    );
    expect(await fake.lines('prompts.jsonl')).toEqual([
      [
        { type: 'text', text: 'look' },
        {
          type: 'image',
          mimeType: 'image/png',
          data: Buffer.from(picture).toString('base64'),
        },
      ],
    ]);
    await expect(
      session.startTurn({
        turnId: 'u',
        clientId: crypto.randomUUID(),
        input: [{ type: 'file', mediaType: 'application/pdf', reference: 'files/a.pdf' }],
      }),
    ).rejects.toThrow('images only');
    await session.close();
  } finally {
    await fake.cleanup();
  }
  const small = await harness([], {
    agent: { FAKE_ACP_IMAGE: '1' },
    driver: { resolveFile: async () => picture, maxImageBytes: 4 },
  });
  const blind = await harness([], { driver: { resolveFile: async () => picture } });
  try {
    const tooBig = await small.driver.open({ profile: small.profile, cwd: small.root });
    await expect(
      tooBig.startTurn({ turnId: 't', clientId: crypto.randomUUID(), input: image }),
    ).rejects.toThrow('over maxImageBytes 4');
    await tooBig.close();
    const noImages = await blind.driver.open({ profile: blind.profile, cwd: blind.root });
    await expect(
      noImages.startTurn({ turnId: 't', clientId: crypto.randomUUID(), input: image }),
    ).rejects.toThrow('did not declare image input');
    await noImages.close();
    expect(await blind.lines('prompts.jsonl')).toEqual([]);
  } finally {
    await small.cleanup();
    await blind.cleanup();
  }
});

test('a loaded session replays its history, and none of it reaches the next turn', async () => {
  const fake = await harness([
    update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'new answer' },
    }),
    answer(),
  ]);
  try {
    const session = await fake.driver.open({
      profile: fake.profile,
      cwd: fake.root,
      nativeThreadId: 'kept',
    });
    expect(session.nativeThreadId).toBe('kept');
    const deltas = await drain(
      await session.startTurn({
        turnId: 't',
        clientId: crypto.randomUUID(),
        input: text('hi'),
      }),
    );
    expect(deltas.flatMap((delta) => (delta.type === 'text' ? [delta.text] : []))).toEqual([
      'new answer',
    ]);
    await session.close();
  } finally {
    await fake.cleanup();
  }
});

test('an agent that resumes reopens with session/resume, and both pass the MCP servers', async () => {
  const mcpServers = [
    { name: 'files', command: '/bin/files-mcp', args: ['--root', '.'], env: [] },
  ];
  const resuming = await harness([], {
    agent: { FAKE_ACP_RESUME: '1' },
    driver: { mcpServers },
  });
  const loading = await harness([], { driver: { mcpServers } });
  try {
    for (const fake of [resuming, loading]) {
      const session = await fake.driver.open({
        profile: fake.profile,
        cwd: fake.root,
        nativeThreadId: 'kept',
      });
      await session.close();
    }
    const reopen = async (fake: typeof resuming) =>
      (await fake.lines('methods.jsonl')).filter((entry) =>
        ['session/resume', 'session/load'].includes(entry.method),
      );
    expect(await reopen(resuming)).toMatchObject([
      { method: 'session/resume', params: { mcpServers } },
    ]);
    expect(await reopen(loading)).toMatchObject([
      { method: 'session/load', params: { mcpServers } },
    ]);
    expect(
      await resuming.driver.sessions({ profile: resuming.profile, cwd: resuming.root }),
    ).toEqual([
      {
        sessionId: 'kept',
        cwd: resuming.root,
        title: 'Old work',
        updatedAt: '2026-11-23T10:00:00Z',
      },
    ]);
  } finally {
    await resuming.cleanup();
    await loading.cleanup();
  }
});

test('a missing agent, a signed-out agent and a silent agent each answer at once', async () => {
  const missing = await harness([], {
    driver: { executable: '/nonexistent/acp-agent', args: [] },
  });
  const signedOut = await harness([], { agent: { FAKE_ACP_SIGNED_OUT: '1' } });
  const silent = await harness([], {
    agent: { FAKE_ACP_SILENT: '1' },
    driver: { requestTimeoutMs: 300 },
  });
  try {
    const startedAt = performance.now();
    await expect(
      missing.driver.open({ profile: missing.profile, cwd: missing.root }),
    ).rejects.toThrow('The ACP agent /nonexistent/acp-agent could not run');
    expect((await missing.driver.status(missing.profile)).login.state).toBe('unknown');
    expect(await signedOut.driver.status(signedOut.profile)).toEqual({
      login: { state: 'signed-out' },
      effectiveCredential: 'none',
    });
    await expect(
      silent.driver.open({ profile: silent.profile, cwd: silent.root }),
    ).rejects.toThrow('no answer within 300 ms');
    expect(performance.now() - startedAt).toBeLessThan(10_000);
  } finally {
    await missing.cleanup();
    await signedOut.cleanup();
    await silent.cleanup();
  }
});

test('a frame longer than maxFrameBytes fails the connection rather than growing without bound', async () => {
  const fake = await harness([], {
    agent: { FAKE_ACP_REPLAY_REPEAT: '20000' },
    driver: { maxFrameBytes: 64 * 1024 },
  });
  try {
    await expect(
      fake.driver.open({ profile: fake.profile, cwd: fake.root, nativeThreadId: 'kept' }),
    ).rejects.toThrow();
  } finally {
    await fake.cleanup();
  }
  const roomy = await harness([], { agent: { FAKE_ACP_REPLAY_REPEAT: '20000' } });
  try {
    const session = await roomy.driver.open({
      profile: roomy.profile,
      cwd: roomy.root,
      nativeThreadId: 'kept',
    });
    await session.close();
  } finally {
    await roomy.cleanup();
  }
});
