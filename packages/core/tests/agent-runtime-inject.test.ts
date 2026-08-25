import { describe, expect, test } from 'bun:test';
import { simulateReadableStream, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../src/agent-runtime';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

const protocol = defineAgentProtocol({
  context: z.object({}),
  inputMetadata: z.object({}),
});

const descriptor = {
  provider: 'test',
  modelId: 'test-model',
  contextWindow: 100_000,
  capabilities: [],
};

/** Calls a tool on every step until told to finish, so steps are controllable. */
function steppingModel(input: { steps: number; onStep?(call: number): Promise<void> | void }) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      call += 1;
      await input.onStep?.(call);
      const last = call >= input.steps;
      return {
        stream: simulateReadableStream({
          chunks: [
            ...(last
              ? [
                  { type: 'text-start', id: 'text-1' },
                  { type: 'text-delta', id: 'text-1', delta: 'answered' },
                  { type: 'text-end', id: 'text-1' },
                ]
              : [
                  {
                    type: 'tool-call',
                    toolCallId: `call-${call}`,
                    toolName: 'ping',
                    input: '{}',
                  },
                ]),
            {
              type: 'finish',
              finishReason: { unified: last ? 'stop' : 'tool-calls', raw: undefined },
              usage,
            },
          ],
        } as never),
      };
    },
  });
}

function build(model: MockLanguageModelV4, store = createMemoryAgentRuntimeStore()) {
  const runtime = createAgentRuntime({
    protocol,
    store,
    models: { resolve: () => ({ descriptor, model }) },
    prompt: () => ({
      instructions: 'test',
      sections: [],
      instructionTokens: { provenance: 'unavailable' },
      contextDecision: 'unavailable',
    }),
    tools: () => ({
      ping: tool({ description: 'p', inputSchema: z.object({}), execute: async () => 'pong' }),
    }),
    loop: { maxSteps: 10 },
    runs: { inputPolicy: 'inject' },
  });
  return { runtime, store };
}

const send = (
  runtime: ReturnType<typeof createAgentRuntime>,
  idempotencyKey: string,
  text: string,
) =>
  runtime.submit({
    conversationId: 'conversation-1',
    idempotencyKey,
    context: {},
    parts: [{ type: 'text', text }],
    metadata: {},
  });

describe('an input can join a run already in flight', () => {
  test('the run in flight takes it at a step boundary and keeps going', async () => {
    const firstStepEntered = Promise.withResolvers<void>();
    const secondInputAccepted = Promise.withResolvers<void>();
    const model = steppingModel({
      steps: 3,
      onStep: async (call) => {
        if (call === 1) firstStepEntered.resolve();
        // Step two does not begin until the new input is durably queued, so
        // the boundary between them is the one being tested.
        if (call === 2) await secondInputAccepted.promise;
      },
    });
    const { runtime, store } = build(model);
    const first = send(runtime, 'input-1', 'start the task');
    await first.accepted;
    await firstStepEntered.promise;
    const second = send(runtime, 'input-2', 'and also mention the deadline');
    await second.accepted;
    secondInputAccepted.resolve();

    const firstResult = await first.result;
    const secondResult = await second.result;
    await runtime.close();

    // One turn answered both, and both tickets resolve to it.
    expect(secondResult.run.id).toBe(firstResult.run.id);
    expect(secondResult.message.id).toBe(firstResult.message.id);
    expect(firstResult.reason).toBe('success');

    const snapshot = await store.loadSnapshot('conversation-1');
    const answering = snapshot.runs.find((run) => run.id === firstResult.run.id);
    // The durable record says two inputs were answered by one run.
    expect(answering?.inputMessageIds).toHaveLength(2);
    // Both user messages are in history, in order — nothing was swallowed.
    const said = snapshot.messages
      .filter((message) => message.role === 'user')
      .flatMap((message) =>
        message.parts.map((part) => (part.type === 'text' ? part.text : '')),
      );
    expect(said).toEqual(['start the task', 'and also mention the deadline']);
    // The absorbed run leaves the conversation snapshot: a snapshot carries
    // active runs plus those a message references, and it never wrote one.
    expect(snapshot.runs).toHaveLength(1);

    // The provider saw the new message on a step after it arrived.
    const prompts = model.doStreamCalls.map((entry) => JSON.stringify(entry.prompt));
    expect(prompts[0]).not.toContain('mention the deadline');
    expect(prompts.at(-1)).toContain('mention the deadline');
  });

  test('a run that finishes first simply answers it next — nothing is lost', async () => {
    const model = steppingModel({ steps: 1 });
    const { runtime, store } = build(model);
    // The first run is a single step, so it is over before any boundary the
    // second input could be absorbed at. `inject` degrades to `queue`.
    const first = send(runtime, 'input-1', 'one');
    await first.result;
    const second = send(runtime, 'input-2', 'two');
    const secondResult = await second.result;
    await runtime.close();

    expect(secondResult.run.id).not.toBe((await first.result).run.id);
    const snapshot = await store.loadSnapshot('conversation-1');
    expect(snapshot.runs.every((run) => run.state === 'completed')).toBe(true);
    expect(snapshot.runs).toHaveLength(2);
  });
});
