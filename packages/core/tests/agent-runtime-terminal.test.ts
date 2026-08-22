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

    const [secondAdmission, thirdAdmission] = await Promise.all([
      second.admission,
      third.admission,
    ]);
    expect(secondAdmission.runId).toBe(thirdAdmission.runId);
    expect(secondAdmission.assistantMessageId).toBe(thirdAdmission.assistantMessageId);
    expect(secondAdmission.snapshotVersion).toBeLessThan(thirdAdmission.snapshotVersion);

    const queued = await store.loadSnapshot('conversation-1');
    expect(queued.runs).toHaveLength(2);
    expect(queued.runs[1]?.inputMessageIds).toHaveLength(2);
    releasePrompt.resolve();
    await Promise.all([first.result, second.result, third.result]);
    expect(promptCalls).toBe(2);
    expect((await second.result).run.id).toBe((await third.result).run.id);
  });

  test('accepts caller record ids and exposes the assigned admission identity', async () => {
    const store = createMemoryAgentRuntimeStore();
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
      prompt: () => {
        throw new Error('stop after admission probe');
      },
      tools: () => ({}),
    });

    const ticket = runtime.submit({
      conversationId: 'conversation-1',
      idempotencyKey: 'request-1',
      context: {},
      parts: [{ type: 'text', text: 'hello' }],
      metadata: {},
      recordIds: {
        inputMessageId: 'product-user-1',
        runId: 'product-run-1',
        assistantMessageId: 'product-assistant-1',
      },
    });

    await ticket.accepted;
    expect(await ticket.admission).toEqual({
      runId: 'product-run-1',
      assistantMessageId: 'product-assistant-1',
      snapshotVersion: 1,
    });
    const snapshot = await store.loadSnapshot('conversation-1');
    expect(snapshot.messages[0]?.id).toBe('product-user-1');
    expect(snapshot.runs[0]?.assistantMessageId).toBe('product-assistant-1');
    await ticket.result;
  });

  test('returns the durable admission identity for a duplicate with discarded proposals', async () => {
    const store = createMemoryAgentRuntimeStore();
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
      prompt: () => {
        throw new Error('stop after admission probe');
      },
      tools: () => ({}),
    });

    const first = runtime.submit({
      conversationId: 'conversation-1',
      idempotencyKey: 'request-1',
      context: {},
      parts: [{ type: 'text', text: 'hello' }],
      metadata: {},
      recordIds: {
        inputMessageId: 'product-user-1',
        runId: 'product-run-1',
        assistantMessageId: 'product-assistant-1',
      },
    });
    await first.result;

    const duplicate = runtime.submit({
      conversationId: 'conversation-1',
      idempotencyKey: 'request-1',
      context: {},
      parts: [{ type: 'text', text: 'hello' }],
      metadata: {},
      recordIds: {
        inputMessageId: 'product-user-1',
        runId: 'discarded-run',
        assistantMessageId: 'discarded-assistant',
      },
    });

    const duplicateAdmission = await duplicate.admission;
    const duplicateSnapshot = await store.loadSnapshot('conversation-1');
    expect(duplicateAdmission).toEqual({
      runId: 'product-run-1',
      assistantMessageId: 'product-assistant-1',
      snapshotVersion: duplicateSnapshot.version,
    });
    expect((await duplicate.result).run.id).toBe('product-run-1');
  });

  test('keeps runtime tickets distinct for delimiter-bearing identities', async () => {
    const store = createMemoryAgentRuntimeStore();
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
      prompt: () => {
        throw new Error('stop after admission probe');
      },
      tools: () => ({}),
    });

    const first = runtime.submit({
      conversationId: 'a\u0000b',
      idempotencyKey: 'c',
      context: {},
      parts: [{ type: 'text', text: 'one' }],
      metadata: {},
      recordIds: {
        inputMessageId: 'input-1',
        runId: 'run-1',
        assistantMessageId: 'assistant-1',
      },
    });
    const second = runtime.submit({
      conversationId: 'a',
      idempotencyKey: 'b\u0000c',
      context: {},
      parts: [{ type: 'text', text: 'two' }],
      metadata: {},
      recordIds: {
        inputMessageId: 'input-2',
        runId: 'run-2',
        assistantMessageId: 'assistant-2',
      },
    });

    const [firstAdmission, secondAdmission] = await Promise.all([
      first.admission,
      second.admission,
    ]);
    expect(firstAdmission.runId).toBe('run-1');
    expect(secondAdmission.runId).toBe('run-2');
    await Promise.all([first.result, second.result]);
  });

  test('internally observes admission rejection for accepted-result compatibility', async () => {
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({
        context: z.object({}),
        inputMetadata: z.object({}),
      }),
      store: {
        loadSnapshot: () => Promise.reject(new Error('not used')),
        acceptInputAndAssignRun: () => Promise.reject(new Error('admission failed')),
        acquireRun: () => Promise.reject(new Error('not used')),
        checkpointRunAssistant: () => Promise.reject(new Error('not used')),
        requestRunInterrupt: () => Promise.reject(new Error('not used')),
        recoverRun: () => Promise.reject(new Error('not used')),
        commitRunTerminal: () => Promise.reject(new Error('not used')),
        replaceCompactedRange: () => Promise.reject(new Error('not used')),
        scanRecoverable: () => Promise.reject(new Error('not used')),
      },
      models: {
        resolve: () => {
          throw new Error('not used');
        },
      },
      prompt: () => {
        throw new Error('not used');
      },
      tools: () => ({}),
    });

    const ticket = runtime.submit({
      conversationId: 'conversation-1',
      idempotencyKey: 'request-1',
      context: {},
      parts: [{ type: 'text', text: 'hello' }],
      metadata: {},
    });
    const failures = await Promise.allSettled([ticket.accepted, ticket.result]);
    expect(failures.map((failure) => failure.status)).toEqual(['rejected', 'rejected']);
    await Bun.sleep(0);
  });
});
