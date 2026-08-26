import { describe, expect, test } from 'bun:test';
import { simulateReadableStream, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  type AgentInputPolicy,
  type AgentRuntimeEvent,
  type AgentRuntimeInput,
  type AgentRuntimeStore,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../src/agent-runtime';

/**
 * A two-step model with a barrier in the middle.
 *
 * Step one calls a tool and blocks inside it; the test submits while the run is
 * parked there, then releases. Step two is the boundary the injection has to
 * survive, and `prompts` is what actually reached the provider — the only
 * evidence that matters for "did this input reach the model".
 */
function barrierModel(toolSteps = 1) {
  const atTool = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const prompts: unknown[][] = [];
  let call = 0;
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      call += 1;
      prompts.push(prompt as unknown[]);
      const last = call > toolSteps;
      const body = last
        ? [
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'answered' },
            { type: 'text-end', id: 'text-1' },
          ]
        : [
            {
              type: 'tool-call',
              toolCallId: `call-${call}`,
              toolName: 'wait',
              input: '{}',
            },
          ];
      return {
        stream: simulateReadableStream({
          chunks: [
            ...body,
            {
              type: 'finish',
              finishReason: { unified: last ? 'stop' : 'tool-calls', raw: undefined },
              usage: {
                inputTokens: {
                  total: 10,
                  noCache: 10,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: { total: 5, text: 5, reasoning: undefined },
              },
            },
          ],
        } as never),
      };
    },
  });
  return { model, prompts, atTool: atTool.promise, release, arrive: atTool.resolve };
}

function runtimeWith(input: {
  store: AgentRuntimeStore;
  model: MockLanguageModelV4;
  inputPolicy: AgentInputPolicy | ((request: AgentRuntimeInput) => AgentInputPolicy);
  onTool?: (call: number) => Promise<void>;
  coalescePending?: boolean;
  publish?: (event: AgentRuntimeEvent) => void;
}) {
  let toolCalls = 0;
  return createAgentRuntime({
    protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
    store: input.store,
    models: {
      resolve: () => ({
        descriptor: {
          provider: 'test',
          modelId: 'test-model',
          contextWindow: 100_000,
          capabilities: [],
        },
        model: input.model,
      }),
    },
    prompt: () => ({
      instructions: 'test',
      sections: [],
      instructionTokens: { provenance: 'unavailable' },
      contextDecision: 'unavailable',
    }),
    tools: () => ({
      wait: tool({
        description: 'w',
        inputSchema: z.object({}),
        execute: async () => {
          toolCalls += 1;
          await input.onTool?.(toolCalls);
          return 'waited';
        },
      }),
    }),
    loop: { maxSteps: 5 },
    runs: {
      inputPolicy: input.inputPolicy,
      ...(input.coalescePending && { coalescePending: true }),
    },
    ...(input.publish && { publish: input.publish }),
  });
}

const send = (
  runtime: ReturnType<typeof createAgentRuntime>,
  idempotencyKey: string,
  text: string,
) =>
  runtime.submit({
    conversationId: 'c1',
    idempotencyKey,
    context: {},
    parts: [{ type: 'text', text }],
    metadata: {},
  });

const textIn = (prompt: unknown): string => JSON.stringify(prompt);

describe('an input that joins a run in flight', () => {
  test('the run answers it, and the absorption lands with the terminal record', async () => {
    const store = createMemoryAgentRuntimeStore();
    const { model, prompts, atTool, release, arrive } = barrierModel();
    const runtime = runtimeWith({
      store,
      model,
      inputPolicy: 'inject',
      onTool: async () => {
        arrive();
        await release.promise;
      },
    });
    const first = send(runtime, 'input-1', 'summarise this');
    await first.accepted;
    await atTool;
    const second = send(runtime, 'input-2', 'in bullet points');
    const secondAdmission = await second.admission;
    // Durable BEFORE anything is absorbed: an ordinary queued run, which is what
    // makes every abnormal ending safe.
    const queued = await store.loadRun({ conversationId: 'c1', runId: secondAdmission.runId });
    expect(queued?.run.state).toBe('queued');
    release.resolve();

    const firstResult = await first.result;
    const secondResult = await second.result;
    // Both tickets resolve to the same answer, produced once.
    expect(firstResult.run.id).toBe(secondResult.run.id);
    expect(secondResult.message.id).toBe(firstResult.message.id);
    expect(firstResult.reason).toBe('success');

    // The second step's prompt carries the injected text; the first step's does not.
    expect(prompts).toHaveLength(2);
    expect(textIn(prompts[0])).not.toContain('in bullet points');
    expect(textIn(prompts[1])).toContain('in bullet points');

    const absorbing = await store.loadRun({ conversationId: 'c1', runId: firstResult.run.id });
    expect(absorbing?.run.inputMessageIds).toHaveLength(2);
    const absorbed = await store.loadRun({
      conversationId: 'c1',
      runId: secondAdmission.runId,
    });
    expect(absorbed?.run.terminalReason).toBe('absorbed');
    expect(absorbed?.run.state).toBe('superseded');
    expect(absorbed?.run.absorbedIntoRunId).toBe(firstResult.run.id);
    // No answer of its own — it produced none, and inventing an empty one would
    // be a record claiming otherwise.
    expect(absorbed?.assistant).toBeUndefined();
    expect(await store.listActiveRuns('c1')).toEqual([]);
    await runtime.close();
  });

  test('an injected input reaches every later step exactly once', async () => {
    const store = createMemoryAgentRuntimeStore();
    // Three steps. The input is taken at the boundary before step two and has
    // to survive into step three without being sent twice — the SDK carries a
    // `prepareStep` message list forward, so appending the accumulated list at
    // every boundary would duplicate it.
    const { model, prompts, release } = barrierModel(2);
    const atFirstTool = Promise.withResolvers<void>();
    const runtime = runtimeWith({
      store,
      model,
      inputPolicy: 'inject',
      onTool: async (call) => {
        if (call !== 1) return;
        atFirstTool.resolve();
        await release.promise;
      },
    });
    const first = send(runtime, 'input-1', 'summarise this');
    await first.accepted;
    await atFirstTool.promise;
    const second = send(runtime, 'input-2', 'in bullet points');
    await second.admission;
    release.resolve();
    await first.result;
    await second.result;

    expect(prompts).toHaveLength(3);
    const occurrences = (prompt: unknown) =>
      textIn(prompt).split('in bullet points').length - 1;
    expect(occurrences(prompts[0])).toBe(0);
    expect(occurrences(prompts[1])).toBe(1);
    expect(occurrences(prompts[2])).toBe(1);
    await runtime.close();
  });

  test('an absorbed run publishes the state it ended in', async () => {
    const store = createMemoryAgentRuntimeStore();
    const events: AgentRuntimeEvent[] = [];
    const { model, atTool, release, arrive } = barrierModel();
    const runtime = runtimeWith({
      store,
      model,
      inputPolicy: 'inject',
      publish: (event) => {
        events.push(event);
      },
      onTool: async () => {
        arrive();
        await release.promise;
      },
    });
    const first = send(runtime, 'input-1', 'summarise this');
    await first.accepted;
    await atTool;
    const second = send(runtime, 'input-2', 'in bullet points');
    const secondAdmission = await second.admission;
    release.resolve();
    await first.result;
    await second.result;

    // It never enters the executor's body, so this is the only thing that can
    // tell a delivery surface it is not still queued.
    const states = events.filter(
      (event) => event.type === 'run-state' && event.runId === secondAdmission.runId,
    );
    expect(states.map((event) => (event.type === 'run-state' ? event.state : ''))).toEqual([
      'queued',
      'superseded',
    ]);
    await runtime.close();
  });

  test('an unrelated queued input never reaches the absorbing run', async () => {
    const store = createMemoryAgentRuntimeStore();
    const { model, prompts, atTool, release, arrive } = barrierModel();
    const runtime = runtimeWith({
      store,
      model,
      // The policy is per input, which is the shape an application with two
      // delivery surfaces actually has.
      inputPolicy: (request) =>
        request.parts.some((part) => part.type === 'text' && part.text.startsWith('+'))
          ? 'inject'
          : 'queue',
      onTool: async () => {
        arrive();
        await release.promise;
      },
    });
    const first = send(runtime, 'input-1', 'summarise this');
    await first.accepted;
    await atTool;
    const injected = send(runtime, 'input-2', '+in bullet points');
    const queuedOnly = send(runtime, 'input-3', 'and then translate it');
    await Promise.all([injected.accepted, queuedOnly.accepted]);
    release.resolve();

    await first.result;
    expect(textIn(prompts[1])).toContain('in bullet points');
    // The one that did not ask to join did not join. The withdrawn design
    // re-projected the whole snapshot here, so it did — inside a run that never
    // recorded it, and was then answered a second time by its own run.
    expect(textIn(prompts[1])).not.toContain('and then translate it');
    const queuedAdmission = await queuedOnly.admission;
    const stillQueued = await store.loadRun({
      conversationId: 'c1',
      runId: queuedAdmission.runId,
    });
    expect(stillQueued?.run.terminalReason).toBeUndefined();
    await runtime.close({ forceTimeoutMs: 0 });
  });

  test('a terminal commit that never lands leaves an ordinary queued successor', async () => {
    const durable = createMemoryAgentRuntimeStore();
    const store: AgentRuntimeStore = {
      ...durable,
      commitRunTerminal: () => Promise.reject(new Error('process died here')),
    };
    const { model, atTool, release, arrive } = barrierModel();
    const runtime = runtimeWith({
      store,
      model,
      inputPolicy: 'inject',
      onTool: async () => {
        arrive();
        await release.promise;
      },
    });
    const first = send(runtime, 'input-1', 'summarise this');
    await first.accepted;
    await atTool;
    const second = send(runtime, 'input-2', 'in bullet points');
    const secondAdmission = await second.admission;
    release.resolve();
    await expect(first.result).rejects.toThrow('process died here');

    // The absorption is the terminal commit, so no commit means no absorption.
    const successor = await durable.loadRun({
      conversationId: 'c1',
      runId: secondAdmission.runId,
    });
    expect(successor?.run.state).toBe('queued');
    expect(successor?.run.terminalReason).toBeUndefined();

    // And a fresh process answers it as an ordinary queued run. The dead run
    // ahead of it has to be resolved first — a queued successor is not resumed
    // past an unfinished predecessor — which is exactly the ordinary recovery
    // this policy falls back to.
    const restarted = runtimeWith({
      store: durable,
      model: barrierModel().model,
      inputPolicy: 'queue',
    });
    // The dead run ahead of it is released first — `recover` reports a run it
    // resumed, not a run it finished, so the successor is resumed explicitly
    // here and awaited.
    await restarted.recover({
      resolveContext: () => ({}),
      decide: (item) =>
        item.run.state === 'queued'
          ? { action: 'skip' }
          : { action: 'abandon', staleOwner: true },
    });
    const resumed = await restarted.resume({
      conversationId: 'c1',
      runId: secondAdmission.runId,
      context: {},
    }).result;
    expect(resumed.reason).toBe('success');
    expect(resumed.run.id).toBe(secondAdmission.runId);
    await restarted.close();
  });

  test('closing mid-run leaves the input answerable, and says so honestly', async () => {
    const store = createMemoryAgentRuntimeStore();
    const { model, atTool, release, arrive } = barrierModel();
    const runtime = runtimeWith({
      store,
      model,
      inputPolicy: 'inject',
      onTool: async () => {
        arrive();
        await release.promise;
      },
    });
    const first = send(runtime, 'input-1', 'summarise this');
    await first.accepted;
    await atTool;
    const second = send(runtime, 'input-2', 'in bullet points');
    const secondAdmission = await second.admission;
    const closing = runtime.close({ gracePeriodMs: 0 });
    release.resolve();
    const closed = await closing;
    await Promise.allSettled([first.result, second.result]);

    // A closed runtime grants no absorption, so the input is still a queued run
    // that recovery will answer — never an accepted input with nowhere to go.
    const successor = await store.loadRun({
      conversationId: 'c1',
      runId: secondAdmission.runId,
    });
    expect(successor?.run.state).toBe('queued');
    expect(closed.remaining).toBe(0);
  });

  test('retrying the idempotency key after a restart returns the answer', async () => {
    const store = createMemoryAgentRuntimeStore();
    const { model, atTool, release, arrive } = barrierModel();
    const runtime = runtimeWith({
      store,
      model,
      inputPolicy: 'inject',
      onTool: async () => {
        arrive();
        await release.promise;
      },
    });
    const first = send(runtime, 'input-1', 'summarise this');
    await first.accepted;
    await atTool;
    const second = send(runtime, 'input-2', 'in bullet points');
    await second.admission;
    release.resolve();
    const answer = await first.result;
    await second.result;
    await runtime.close();

    // A different process, sharing only the store — so the redirect has to be
    // durable, not something the first runtime remembered.
    const restarted = runtimeWith({
      store,
      model: barrierModel().model,
      inputPolicy: 'inject',
    });
    const retry = send(restarted, 'input-2', 'in bullet points');
    const retried = await retry.result;
    expect(retried.run.id).toBe(answer.run.id);
    expect(retried.message.id).toBe(answer.message.id);
    expect(retried.reason).toBe('success');
    await restarted.close();
  });

  test('an interrupted run absorbs nothing, and the successor answers itself', async () => {
    const store = createMemoryAgentRuntimeStore();
    const { model, atTool, release, arrive } = barrierModel();
    const runtime = runtimeWith({
      store,
      model,
      inputPolicy: 'inject',
      onTool: async () => {
        arrive();
        await release.promise;
      },
    });
    const first = send(runtime, 'input-1', 'summarise this');
    const firstAdmission = await first.admission;
    await atTool;
    const second = send(runtime, 'input-2', 'in bullet points');
    const secondAdmission = await second.admission;
    await runtime.interrupt({ conversationId: 'c1', runId: firstAdmission.runId });
    release.resolve();
    await first.result;

    const interrupted = await store.loadRun({
      conversationId: 'c1',
      runId: firstAdmission.runId,
    });
    expect(interrupted?.run.terminalReason).toBe('interrupted');
    // It took the input into its prompt and then stopped. It has not answered
    // it, so it does not get to say it did.
    expect(interrupted?.run.inputMessageIds).toHaveLength(1);
    await second.result;
    const successor = await store.loadRun({
      conversationId: 'c1',
      runId: secondAdmission.runId,
    });
    expect(successor?.run.terminalReason).toBe('success');
    await runtime.close();
  });

  test('a run that is interrupted AFTER taking an input on absorbs nothing', async () => {
    const store = createMemoryAgentRuntimeStore();
    // Two tool steps: the input is taken at the boundary before the second one,
    // and the interrupt lands while that second tool is running. So the
    // absorption really is pending when the run stops — which is the case the
    // single-step version above cannot reach.
    const { model, prompts, release } = barrierModel(2);
    const atFirstTool = Promise.withResolvers<void>();
    const atSecondTool = Promise.withResolvers<void>();
    const releaseSecond = Promise.withResolvers<void>();
    const runtime = runtimeWith({
      store,
      model,
      inputPolicy: 'inject',
      onTool: async (call) => {
        if (call === 1) {
          atFirstTool.resolve();
          await release.promise;
          return;
        }
        atSecondTool.resolve();
        await releaseSecond.promise;
      },
    });
    const first = send(runtime, 'input-1', 'summarise this');
    const firstAdmission = await first.admission;
    await atFirstTool.promise;
    const second = send(runtime, 'input-2', 'in bullet points');
    const secondAdmission = await second.admission;
    release.resolve();
    await atSecondTool.promise;
    // It really was taken: the second step's prompt has it.
    expect(textIn(prompts[1])).toContain('in bullet points');
    await runtime.interrupt({ conversationId: 'c1', runId: firstAdmission.runId });
    releaseSecond.resolve();
    await first.result;

    const interrupted = await store.loadRun({
      conversationId: 'c1',
      runId: firstAdmission.runId,
    });
    expect(interrupted?.run.terminalReason).toBe('interrupted');
    expect(interrupted?.run.inputMessageIds).toEqual([firstAdmission.inputMessageId]);
    const successor = await store.loadRun({
      conversationId: 'c1',
      runId: secondAdmission.runId,
    });
    // Still queued at the moment the absorbing run gave up on it, and answered
    // by its own run afterwards.
    expect(successor?.run.absorbedIntoRunId).toBeUndefined();
    await second.result;
    const answered = await store.loadRun({
      conversationId: 'c1',
      runId: secondAdmission.runId,
    });
    expect(answered?.run.terminalReason).toBe('success');
    await runtime.close();
  });

  test('a run that fails after taking an input on still records its failure', async () => {
    const store = createMemoryAgentRuntimeStore();
    const atFirstTool = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let call = 0;
    // Step one calls a tool; step two throws. No revision drift, so nothing
    // else can quietly drop the pending absorption on the way — if the
    // executor offered it here, the store would refuse the whole commit and the
    // run's terminal record would be lost over a successor's bookkeeping.
    const model = new MockLanguageModelV4({
      doStream: async () => {
        call += 1;
        if (call > 1) throw new Error('provider exploded');
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'tool-call', toolCallId: 'call-1', toolName: 'wait', input: '{}' },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: undefined },
                usage: {
                  inputTokens: {
                    total: 10,
                    noCache: 10,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: { total: 5, text: 5, reasoning: undefined },
                },
              },
            ],
          } as never),
        };
      },
    });
    const runtime = runtimeWith({
      store,
      model,
      inputPolicy: 'inject',
      onTool: async () => {
        atFirstTool.resolve();
        await release.promise;
      },
    });
    const first = send(runtime, 'input-1', 'summarise this');
    const firstAdmission = await first.admission;
    await atFirstTool.promise;
    const second = send(runtime, 'input-2', 'in bullet points');
    const secondAdmission = await second.admission;
    release.resolve();

    const failed = await first.result;
    expect(failed.reason).toBe('provider_failure');
    const failedRun = await store.loadRun({
      conversationId: 'c1',
      runId: firstAdmission.runId,
    });
    expect(failedRun?.run.terminalReason).toBe('provider_failure');
    expect(failedRun?.run.inputMessageIds).toEqual([firstAdmission.inputMessageId]);
    await second.result.catch(() => undefined);
    const successor = await store.loadRun({
      conversationId: 'c1',
      runId: secondAdmission.runId,
    });
    // Never absorbed — it answers itself, whatever it ends up saying.
    expect(successor?.run.absorbedIntoRunId).toBeUndefined();
    expect(successor?.run.terminalReason).not.toBe('absorbed');
    await runtime.close({ forceTimeoutMs: 0 });
  });

  test('inject composes with coalescePending, and absorbs the successor whole', async () => {
    const store = createMemoryAgentRuntimeStore();
    const { model, prompts, atTool, release, arrive } = barrierModel();
    const runtime = runtimeWith({
      store,
      model,
      inputPolicy: 'inject',
      coalescePending: true,
      onTool: async () => {
        arrive();
        await release.promise;
      },
    });
    const first = send(runtime, 'input-1', 'summarise this');
    await first.accepted;
    await atTool;
    const second = send(runtime, 'input-2', 'in bullet points');
    const third = send(runtime, 'input-3', 'and keep it short');
    const [secondAdmission, thirdAdmission] = await Promise.all([
      second.admission,
      third.admission,
    ]);
    // One successor carrying two inputs — which is what makes "whole or not at
    // all" a real constraint rather than a slogan.
    expect(thirdAdmission.runId).toBe(secondAdmission.runId);
    release.resolve();

    const answer = await first.result;
    expect(textIn(prompts[1])).toContain('in bullet points');
    expect(textIn(prompts[1])).toContain('and keep it short');
    const absorbed = await store.loadRun({
      conversationId: 'c1',
      runId: secondAdmission.runId,
    });
    expect(absorbed?.run.terminalReason).toBe('absorbed');
    expect(absorbed?.run.inputMessageIds).toHaveLength(2);
    const absorbing = await store.loadRun({ conversationId: 'c1', runId: answer.run.id });
    expect(absorbing?.run.inputMessageIds).toHaveLength(3);
    // Both tickets resolve to the run that answered them. Not deep-equal to
    // `answer`: this executor produced nothing, so it reports no metrics — and
    // claiming a duration and a token count it never spent would be the lie
    // this whole design exists to avoid.
    const [secondResult, thirdResult] = await Promise.all([second.result, third.result]);
    for (const resolved of [secondResult, thirdResult]) {
      expect(resolved.run.id).toBe(answer.run.id);
      expect(resolved.message.id).toBe(answer.message.id);
      expect(resolved.reason).toBe('success');
      expect(resolved.metrics).toBeUndefined();
    }
    await runtime.close();
  });

  test('the store refuses an absorption that names nonsense', async () => {
    const store = createMemoryAgentRuntimeStore();
    const message = (id: string, role: 'user' | 'assistant', extra: object = {}) => ({
      schemaVersion: 1 as const,
      id,
      conversationId: 'nonsense',
      role,
      status: role === 'user' ? ('committed' as const) : ('completed' as const),
      parts: [{ type: 'text' as const, text: id }],
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z',
      ...extra,
    });
    const accepted = await store.acceptInputAndAssignRun({
      idempotencyKey: 'k1',
      input: message('u1', 'user'),
      run: {
        schemaVersion: 1,
        id: 'r1',
        conversationId: 'nonsense',
        inputMessageIds: ['u1'],
        assistantMessageId: 'a1',
        state: 'queued',
        revision: 0,
        createdAt: '2026-08-26T00:00:00.000Z',
        updatedAt: '2026-08-26T00:00:00.000Z',
      },
    });
    expect(accepted.outcome).toBe('applied');
    const acquired = await store.acquireRun({
      conversationId: 'nonsense',
      runId: 'r1',
      expectedRevision: 0,
      ownerId: 'owner',
    });
    expect(acquired.outcome).toBe('applied');
    const running =
      acquired.outcome === 'applied'
        ? acquired.snapshot.runs.find((run) => run.id === 'r1')
        : undefined;
    const answer = message('a1', 'assistant', { runId: 'r1' });
    const commit = (extra: object) =>
      store.commitRunTerminal({
        conversationId: 'nonsense',
        runId: 'r1',
        expectedRevision: running?.revision ?? 0,
        ownerId: 'owner',
        assistant: answer,
        reason: 'success',
        ...extra,
      });
    // A run cannot absorb itself, and a successor cannot be named twice.
    await expect(
      commit({ absorb: [{ runId: 'r1', inputMessageIds: ['u1'] }] }),
    ).rejects.toThrow('never the absorbing run');
    await expect(
      commit({
        absorb: [
          { runId: 'other', inputMessageIds: ['x'] },
          { runId: 'other', inputMessageIds: ['y'] },
        ],
      }),
    ).rejects.toThrow('names each successor once');
    // And `absorbed` is not a reason a caller may commit directly.
    await expect(
      commit({ reason: 'absorbed', assistant: { ...answer, status: 'superseded' } }),
    ).rejects.toThrow('never terminalized as absorbed');
  });

  test('a runtime that cannot inject installs nothing', async () => {
    const store = createMemoryAgentRuntimeStore();
    const { model, prompts, atTool, release, arrive } = barrierModel();
    const runtime = runtimeWith({
      store,
      model,
      inputPolicy: 'queue',
      onTool: async () => {
        arrive();
        await release.promise;
      },
    });
    const first = send(runtime, 'input-1', 'summarise this');
    await first.accepted;
    await atTool;
    const second = send(runtime, 'input-2', 'in bullet points');
    await second.admission;
    release.resolve();
    await first.result;
    expect(textIn(prompts[1])).not.toContain('in bullet points');
    await second.result;
    await runtime.close();
  });
});
