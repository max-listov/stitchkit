import { describe, expect, test } from 'bun:test';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../src/agent-runtime';

describe('agent runtime terminalization', () => {
  test('commits a provider failure when prompt construction fails before streaming', async () => {
    const store = createMemoryAgentRuntimeStore();
    const failure = new Error('internal provider setup failed');
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({
        context: z.object({}),
        inputMetadata: z.object({ channel: z.literal('test') }),
      }),
      store,
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'test',
            modelId: 'test-model',
            contextWindow: 1_000,
            capabilities: [],
          },
          model: new MockLanguageModelV4(),
        }),
      },
      prompt: () => {
        throw failure;
      },
      tools: () => ({}),
      generateId: (() => {
        let id = 0;
        return () => `id-${++id}`;
      })(),
      now: () => new Date('2026-08-22T00:00:00.000Z'),
    });

    const ticket = runtime.submit({
      conversationId: 'conversation-1',
      idempotencyKey: 'input-1',
      context: {},
      parts: [{ type: 'text', text: 'hello' }],
      metadata: { channel: 'test' },
    });
    await ticket.accepted;
    const terminal = await ticket.result;

    expect(terminal.reason).toBe('provider_failure');
    expect(terminal.run.state).toBe('failed');
    expect(terminal.message.status).toBe('failed');
    const snapshot = await store.loadSnapshot('conversation-1');
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0]?.terminalReason).toBe('provider_failure');
    expect(snapshot.messages[0]?.metadata).toEqual({ channel: 'test' });
  });

  test('coalesces inputs behind an active run into one durable successor', async () => {
    const store = createMemoryAgentRuntimeStore();
    const promptEntered = Promise.withResolvers<void>();
    const releasePrompt = Promise.withResolvers<void>();
    let promptCalls = 0;
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({
        context: z.object({}),
        inputMetadata: z.object({}),
      }),
      store,
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'test',
            modelId: 'test-model',
            contextWindow: 1_000,
            capabilities: [],
          },
          model: new MockLanguageModelV4(),
        }),
      },
      prompt: async () => {
        promptCalls += 1;
        if (promptCalls === 1) {
          promptEntered.resolve();
          await releasePrompt.promise;
        }
        throw new Error('stop after admission probe');
      },
      tools: () => ({}),
      runs: { coalescePending: true },
    });
    const submit = (idempotencyKey: string, text: string) =>
      runtime.submit({
        conversationId: 'conversation-1',
        idempotencyKey,
        context: {},
        parts: [{ type: 'text', text }],
        metadata: {},
      });

    const first = submit('input-1', 'one');
    await first.accepted;
    await promptEntered.promise;
    const second = submit('input-2', 'two');
    const third = submit('input-3', 'three');
    await Promise.all([second.accepted, third.accepted]);

    const queued = await store.loadSnapshot('conversation-1');
    expect(queued.runs).toHaveLength(2);
    expect(queued.runs[1]?.inputMessageIds).toHaveLength(2);
    releasePrompt.resolve();
    await Promise.all([first.result, second.result, third.result]);
    expect(promptCalls).toBe(2);
    expect((await second.result).run.id).toBe((await third.result).run.id);
  });
});
