import { describe, expect, test } from 'bun:test';
import {
  type ExecutorDelta,
  ExecutorEngineSchema,
  projectExecutorDeltas,
} from '../../src/entrypoints/agent-executor';
import {
  createReplayExecutorDriver,
  createReplayGate,
  formatReplayTranscript,
  parseReplayTranscript,
  REPLAY_SCENARIOS,
  replayDialectScenarios,
  runAgentEngineConformance,
  unpackReplayScenario,
} from '../../src/entrypoints/agent-executor/testing';

async function collectTurn(
  turn: { deltas: AsyncIterable<ExecutorDelta> },
  onDelta?: (delta: ExecutorDelta) => Promise<void>,
): Promise<ExecutorDelta[]> {
  const out: ExecutorDelta[] = [];
  for await (const delta of turn.deltas) {
    out.push(delta);
    await onDelta?.(delta);
  }
  return out;
}

describe('createReplayExecutorDriver', () => {
  test('passes the entire agent-executor conformance suite in-process for both reconcile modes', async () => {
    for (const [engine, reconcile] of [
      ['acp', 'none'],
      ['codex', 'client-id'],
    ] as const) {
      await runAgentEngineConformance({
        scenarios: replayDialectScenarios(),
        async open(scenario) {
          const driver = createReplayExecutorDriver({
            engine,
            reconcile,
            turns: [unpackReplayScenario(scenario)],
          });
          return {
            driver,
            profile: { profileId: `replay-${engine}`, engine, home: '/tmp' },
            cwd: '/tmp',
            inputs: async (threadId) => driver.inputsFor(threadId),
            answered: async (req) => driver.wasAnswered(req.interactionId),
            cleanup: async () => undefined,
          };
        },
      });
    }
    // Above the kit's own 10 s bound: a wait that hangs fails by the name of its check.
  }, 30_000);

  test('does not widen ExecutorEngineSchema and supports all 4 wire engines plus info/models/capabilities', async () => {
    expect(ExecutorEngineSchema.options).toEqual(['claude-cli', 'claude-sdk', 'codex', 'acp']);
    const driver = createReplayExecutorDriver({
      engine: 'claude-sdk',
      reconcile: 'client-id',
      version: '2.0.0-replay',
      models: ['claude-sonnet-4-6'],
      capabilities: { steer: true },
      turns: [REPLAY_SCENARIOS['text-stream']],
    });
    const info = await driver.info();
    expect(info.engine).toBe('claude-sdk');
    expect(info.version).toBe('2.0.0-replay');
    expect(info.reconcile).toBe('client-id');
    expect(info.models).toEqual({ answer: 'listed', ids: ['claude-sonnet-4-6'] });
    expect(info.capabilities?.steer).toBe(true);
  });

  test("a caller abort fails the turn waiting on expectReply with the caller's reason and refuses respond and startTurn", async () => {
    const step = (value: unknown) => JSON.stringify(value);
    const driver = createReplayExecutorDriver({
      turns: [
        [
          step({ kind: 'request', interactionId: 'r1', requestKind: 'approval' }),
          step({ kind: 'expectReply', interactionId: 'r1' }),
          step({ kind: 'emit', block: 'turn-end', outcome: 'completed' }),
        ].join('\n'),
        step({ kind: 'emit', block: 'turn-end', outcome: 'completed' }),
      ],
    });
    const controller = new AbortController();
    const reason = new Error('caller abort');
    const session = await driver.open({
      profile: { profileId: 'p', engine: 'acp', home: '/tmp' },
      cwd: '/tmp',
      signal: controller.signal,
    });
    const turn = await session.startTurn({
      turnId: 't1',
      clientId: 'c1',
      input: [{ type: 'text', text: 'hi' }],
    });
    // Before the fix the stream waited forever: nothing listened to the caller's signal.
    const failure = await collectTurn(turn, async (delta) => {
      if (delta.type === 'request') controller.abort(reason);
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBe(reason);
    await expect(turn.respond('r1', { kind: 'approve' })).rejects.toBe(reason);
    await expect(
      session.startTurn({
        turnId: 't2',
        clientId: 'c2',
        input: [{ type: 'text', text: 'x' }],
      }),
    ).rejects.toBe(reason);
    // The second transcript was not consumed by the refused start.
    expect(driver.inputsFor(session.nativeThreadId)).toBe(1);
    await session.close();
  });

  test('deterministically pauses and resumes via createReplayGate without timers', async () => {
    const gate = createReplayGate(['before-answer']);
    const transcript = formatReplayTranscript([
      { kind: 'emit', block: 'text', text: 'first ', itemId: 'm1' },
      { kind: 'gate', label: 'before-answer' },
      { kind: 'emit', block: 'text', text: 'second', itemId: 'm1' },
      { kind: 'emit', block: 'turn-end', outcome: 'completed' },
    ]);
    const driver = createReplayExecutorDriver({
      engine: 'acp',
      gate,
      turns: [transcript],
    });
    const session = await driver.open({
      profile: { profileId: 'p1', engine: 'acp', home: '/tmp' },
      cwd: '/tmp',
    });
    const turn = await session.startTurn({
      turnId: 't1',
      clientId: 'c1',
      input: [{ type: 'text', text: 'go' }],
    });
    const collected = collectTurn(turn);
    expect(await gate.waitForReached('before-answer')).toBe(true);
    expect(gate.hasReached('before-answer')).toBe(true);
    expect(gate.release('before-answer')).toBe(true);
    expect(gate.release('before-answer')).toBe(false);
    const deltas = await collected;
    expect(projectExecutorDeltas(deltas)).toEqual([{ type: 'text', text: 'first second' }]);
    await session.close();
  });

  test('plays every REPLAY_SCENARIOS preset deterministically with workspace substitution', async () => {
    // text-stream (status + reasoning + text + usage + contextUsage)
    const textDriver = createReplayExecutorDriver({
      engine: 'claude-sdk',
      turns: [REPLAY_SCENARIOS['text-stream']],
      assertCompleteOnClose: true,
    });
    const textSession = await textDriver.open({
      profile: { profileId: 'p-text', engine: 'claude-sdk', home: '/tmp' },
      cwd: '/tmp',
    });
    const textDeltas = await collectTurn(
      await textSession.startTurn({
        turnId: 't-text',
        clientId: 'c-text',
        input: [{ type: 'text', text: 'stream' }],
      }),
    );
    expect(textDeltas.some((d) => d.type === 'status' && d.phase === 'initializing')).toBe(
      true,
    );
    expect(textDeltas.some((d) => d.type === 'usage')).toBe(true);
    expect(
      textDeltas.some((d) => d.type === 'turn-end' && d.threadDisposition === 'reusable'),
    ).toBe(true);
    expect(projectExecutorDeltas(textDeltas)).toEqual([
      { type: 'text', text: 'Hello from replay.' },
    ]);
    await textSession.close();

    // tool-calls (reasoning + tool-call + tool-result + context-usage + workspace substitution)
    const toolsDriver = createReplayExecutorDriver({
      engine: 'codex',
      workspace: '/work/demo',
      turns: [REPLAY_SCENARIOS['tool-calls']],
      assertCompleteOnClose: true,
    });
    const toolsSession = await toolsDriver.open({
      profile: { profileId: 'p-tools', engine: 'codex', home: '/tmp' },
      cwd: '/work/demo',
    });
    const toolDeltas = await collectTurn(
      await toolsSession.startTurn({
        turnId: 't-tools',
        clientId: 'c-tools',
        input: [{ type: 'text', text: 'inspect' }],
      }),
    );
    expect(toolDeltas.some((d) => d.type === 'reasoning')).toBe(true);
    const toolCallDelta = toolDeltas.find((d) => d.type === 'tool-call');
    expect(
      toolCallDelta?.type === 'tool-call' && JSON.stringify(toolCallDelta.input),
    ).toContain('/work/demo');
    expect(toolDeltas.some((d) => d.type === 'tool-result')).toBe(true);
    expect(toolDeltas.some((d) => d.type === 'context-usage')).toBe(true);
    await toolsSession.close();

    // approval + workspace substitution + scope check
    const approvalDriver = createReplayExecutorDriver({
      engine: 'codex',
      workspace: '/work/demo',
      turns: [REPLAY_SCENARIOS.approval],
      assertCompleteOnClose: true,
    });
    const approvalSession = await approvalDriver.open({
      profile: { profileId: 'p1', engine: 'codex', home: '/tmp' },
      cwd: '/work/demo',
    });
    const approvalTurn = await approvalSession.startTurn({
      turnId: 't-app',
      clientId: 'c-app',
      input: [{ type: 'text', text: 'list' }],
    });
    const approvalDeltas = await collectTurn(approvalTurn, async (delta) => {
      if (delta.type === 'request') {
        expect(delta.input).toEqual({ command: 'ls /work/demo' });
        await approvalTurn.respond(delta.interactionId, { kind: 'approve', scope: 'session' });
      }
    });
    expect(projectExecutorDeltas(approvalDeltas).at(-1)).toEqual({
      type: 'text',
      text: 'Listed workspace files.',
    });
    await approvalSession.close();

    // user-input
    const inputDriver = createReplayExecutorDriver({
      engine: 'codex',
      turns: [REPLAY_SCENARIOS['user-input']],
    });
    const inputSession = await inputDriver.open({
      profile: { profileId: 'p1', engine: 'codex', home: '/tmp' },
      cwd: '/tmp',
    });
    const inputTurn = await inputSession.startTurn({
      turnId: 't-in',
      clientId: 'c-in',
      input: [{ type: 'text', text: 'pick' }],
    });
    await collectTurn(inputTurn, async (delta) => {
      if (delta.type === 'request') {
        await inputTurn.respond(delta.interactionId, {
          kind: 'input',
          value: { env: 'staging' },
        });
      }
    });
    inputDriver.assertComplete();
    await inputSession.close();

    // rate-limit
    const rateDriver = createReplayExecutorDriver({
      engine: 'claude-cli',
      turns: [REPLAY_SCENARIOS['rate-limit']],
    });
    const rateSession = await rateDriver.open({
      profile: { profileId: 'p-rate', engine: 'claude-cli', home: '/tmp' },
      cwd: '/tmp',
    });
    const rateDeltas = await collectTurn(
      await rateSession.startTurn({
        turnId: 't-r',
        clientId: 'c-r',
        input: [{ type: 'text', text: 'hi' }],
      }),
    );
    expect(rateDeltas.some((d) => d.type === 'error' && d.kind === 'rateLimited')).toBe(true);
    const status = await rateDriver.status({
      profileId: 'p-rate',
      engine: 'claude-cli',
      home: '/tmp',
    });
    expect(status.planLimits?.answer).toBe('known');
    await rateSession.close();

    // multi-turn
    const multiDriver = createReplayExecutorDriver({
      engine: 'acp',
      turns: REPLAY_SCENARIOS['multi-turn'],
      assertCompleteOnClose: true,
    });
    const multiSession = await multiDriver.open({
      profile: { profileId: 'p-m', engine: 'acp', home: '/tmp' },
      cwd: '/tmp',
    });
    const d1 = await collectTurn(
      await multiSession.startTurn({
        turnId: 't1',
        clientId: 'c1',
        input: [{ type: 'text', text: '1' }],
      }),
    );
    const d2 = await collectTurn(
      await multiSession.startTurn({
        turnId: 't2',
        clientId: 'c2',
        input: [{ type: 'text', text: '2' }],
      }),
    );
    expect(projectExecutorDeltas(d1)).toEqual([{ type: 'text', text: 'First turn done.' }]);
    expect(projectExecutorDeltas(d2)).toEqual([{ type: 'text', text: 'Second turn done.' }]);
    await multiSession.close();

    // crash-mid-turn
    const crashDriver = createReplayExecutorDriver({
      engine: 'acp',
      turns: [REPLAY_SCENARIOS['crash-mid-turn']],
    });
    const crashSession = await crashDriver.open({
      profile: { profileId: 'p-c', engine: 'acp', home: '/tmp' },
      cwd: '/tmp',
    });
    const crashTurn = await crashSession.startTurn({
      turnId: 'tc',
      clientId: 'cc',
      input: [{ type: 'text', text: 'go' }],
    });
    await expect(collectTurn(crashTurn)).rejects.toThrow(/crash/i);
    await crashSession.close();
  });

  test('negative controls: rejects malformed NDJSON, byte/step caps, duplicate gate labels, and incomplete runs', async () => {
    expect(() => parseReplayTranscript('{not-json')).toThrow(SyntaxError);
    expect(() => parseReplayTranscript('{"kind":"unknown"}')).toThrow();
    expect(() =>
      parseReplayTranscript(REPLAY_SCENARIOS['text-stream'], { maxBytes: 10 }),
    ).toThrow(RangeError);
    expect(() =>
      parseReplayTranscript(REPLAY_SCENARIOS['text-stream'], { maxSteps: 1 }),
    ).toThrow(RangeError);
    expect(() => createReplayGate(['dup', 'dup'])).toThrow(TypeError);
    expect(() => createReplayGate(['  '])).toThrow(TypeError);

    // 1) Unstarted second turn fails assertComplete and assertCompleteOnClose.
    const incomplete = createReplayExecutorDriver({
      engine: 'acp',
      turns: REPLAY_SCENARIOS['multi-turn'],
      assertCompleteOnClose: true,
    });
    const session = await incomplete.open({
      profile: { profileId: 'p1', engine: 'acp', home: '/tmp' },
      cwd: '/tmp',
    });
    await collectTurn(
      await session.startTurn({
        turnId: 't1',
        clientId: 'c1',
        input: [{ type: 'text', text: '1' }],
      }),
    );
    expect(() => incomplete.assertComplete()).toThrow(/incomplete/i);
    await expect(session.close()).rejects.toThrow(/incomplete/i);

    // 2) Closing while waiting on a required expectReply must fail even though loseEngineTurn drains pending requests.
    const pendingReplyDriver = createReplayExecutorDriver({
      engine: 'codex',
      turns: [REPLAY_SCENARIOS.approval],
      assertCompleteOnClose: true,
    });
    const pendingSession = await pendingReplyDriver.open({
      profile: { profileId: 'p2', engine: 'codex', home: '/tmp' },
      cwd: '/tmp',
    });
    const pendingTurn = await pendingSession.startTurn({
      turnId: 't-pend',
      clientId: 'c-pend',
      input: [{ type: 'text', text: 'list' }],
    });
    const pendingIter = pendingTurn.deltas[Symbol.asyncIterator]();
    const first = await pendingIter.next();
    expect(first.done).toBe(false);
    await expect(pendingSession.close()).rejects.toThrow(/incomplete/i);
    expect(() => pendingReplyDriver.assertComplete()).toThrow(/incomplete/i);

    // 3) Closing while paused on a gate fails assertCompleteOnClose.
    const gate = createReplayGate(['hold']);
    const gatedDriver = createReplayExecutorDriver({
      engine: 'acp',
      gate,
      turns: [
        formatReplayTranscript([
          { kind: 'gate', label: 'hold' },
          { kind: 'emit', block: 'turn-end', outcome: 'completed' },
        ]),
      ],
      assertCompleteOnClose: true,
    });
    const gatedSession = await gatedDriver.open({
      profile: { profileId: 'p3', engine: 'acp', home: '/tmp' },
      cwd: '/tmp',
    });
    await gatedSession.startTurn({
      turnId: 't-gate',
      clientId: 'c-gate',
      input: [{ type: 'text', text: 'wait' }],
    });
    expect(await gate.waitForReached('hold')).toBe(true);
    await expect(gatedSession.close()).rejects.toThrow(/incomplete/i);

    // 4) Early turn-end before a required expectReply still fails assertComplete.
    const earlyEndDriver = createReplayExecutorDriver({
      engine: 'acp',
      turns: [
        formatReplayTranscript([
          { kind: 'emit', block: 'turn-end', outcome: 'completed' },
          { kind: 'expectReply', interactionId: 'never-asked', required: true },
        ]),
      ],
      assertCompleteOnClose: true,
    });
    const earlyEndSession = await earlyEndDriver.open({
      profile: { profileId: 'p4', engine: 'acp', home: '/tmp' },
      cwd: '/tmp',
    });
    await collectTurn(
      await earlyEndSession.startTurn({
        turnId: 't-early',
        clientId: 'c-early',
        input: [{ type: 'text', text: 'done' }],
      }),
    );
    expect(() => earlyEndDriver.assertComplete()).toThrow(/unconsumed required step/i);
    await expect(earlyEndSession.close()).rejects.toThrow(/unconsumed required step/i);
  });
});
