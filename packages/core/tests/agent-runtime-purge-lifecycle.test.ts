import { expect, test } from 'bun:test';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  AgentConversationPurgedError,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
  purgeAgentConversation,
} from '../src/agent-runtime';
import {
  createAgentHarnessControlServer,
  createHeadlessAgentHarness,
} from '../src/agent-runtime-harness';
import { purgeAdmission } from './fixtures/agent-purge';

function models(preflight?: () => Promise<void>) {
  return {
    preflight,
    resolve: () => ({
      descriptor: {
        provider: 'fixture',
        modelId: 'unused',
        contextWindow: 8_000,
        capabilities: [],
      },
      model: new MockLanguageModelV4(),
    }),
  };
}

test('purge fences a runtime submission paused in provider preflight', async () => {
  const store = createMemoryAgentRuntimeStore();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let executed = false;
  const runtime = createAgentRuntime({
    store,
    protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
    models: models(async () => {
      entered.resolve();
      await release.promise;
    }),
    prompt: () => {
      executed = true;
      throw new Error('must not execute');
    },
    tools: () => ({}),
  });
  try {
    const ticket = runtime.submit({
      conversationId: 'target',
      idempotencyKey: 'pending',
      context: {},
      parts: [{ type: 'text', text: 'late' }],
    });
    void ticket.result.catch(() => undefined);
    await entered.promise;
    expect(await purgeAgentConversation(store, { conversationId: 'target' })).toEqual({
      outcome: 'purged',
    });
    release.resolve();
    await expect(ticket.result).rejects.toBeInstanceOf(AgentConversationPurgedError);
    expect(executed).toBe(false);
    expect((await store.loadSnapshot('target')).messages).toEqual([]);
  } finally {
    release.resolve();
    await runtime.close();
  }
});

test('a recovery decision paused across abandonment and purge cannot requeue or execute', async () => {
  const store = createMemoryAgentRuntimeStore();
  await store.acceptInputAndAssignRun(purgeAdmission());
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let executed = false;
  const runtime = createAgentRuntime({
    store,
    protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
    models: models(),
    prompt: () => {
      executed = true;
      throw new Error('must not execute');
    },
    tools: () => ({}),
  });
  try {
    const recovery = runtime.recover({
      resolveContext: () => ({}),
      decide: async () => {
        entered.resolve();
        await release.promise;
        return { action: 'requeue', replaySafe: true };
      },
    });
    await entered.promise;
    expect(await purgeAgentConversation(store, { conversationId: 'target' })).toEqual({
      outcome: 'active',
      runIds: ['run-1'],
    });
    expect(
      (
        await store.recoverRun({
          conversationId: 'target',
          runId: 'run-1',
          expectedRevision: 0,
          action: 'abandon',
        })
      ).outcome,
    ).toBe('applied');
    await purgeAgentConversation(store, { conversationId: 'target' });
    release.resolve();
    expect(await recovery).toEqual([
      {
        conversationId: 'target',
        runId: 'run-1',
        outcome: 'failed',
        error: expect.any(AgentConversationPurgedError),
      },
    ]);
    expect(executed).toBe(false);
    expect((await store.scanRecoverable({ limit: 10 })).items).toEqual([]);
  } finally {
    release.resolve();
    await runtime.close();
  }
});

test('an attached controller lease cannot recreate a purged conversation', async () => {
  const store = createMemoryAgentRuntimeStore();
  const harness = createHeadlessAgentHarness({
    store,
    protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
    models: models(),
    resources: { load: () => ({ resources: [], diagnostics: [] }) },
    promptBudget: ({ contextWindow }) => ({
      contextWindow,
      reservedOutput: 1_000,
      toolSchemas: { value: 0, provenance: 'measured' },
      attachments: { value: 0, provenance: 'measured' },
      providerOverhead: { provenance: 'unavailable' },
    }),
    tools: () => ({}),
  });
  const server = createAgentHarnessControlServer(harness);
  const connection = server.connect({
    id: 'controller',
    deliver: () => undefined,
    onOverflow: () => undefined,
  });
  try {
    expect(
      (
        await connection.request({
          schemaVersion: 1,
          requestId: 'attach',
          operation: 'attach',
          conversationId: 'target',
          access: 'control',
        })
      ).outcome,
    ).toBe('ok');
    await purgeAgentConversation(store, { conversationId: 'target' });
    expect(
      (
        await connection.request({
          schemaVersion: 1,
          requestId: 'submit',
          operation: 'submit',
          conversationId: 'target',
          idempotencyKey: 'late',
          context: {},
          parts: [{ type: 'text', text: 'late' }],
        })
      ).outcome,
    ).toBe('error');
    expect((await harness.snapshot('target')).messages).toEqual([]);
  } finally {
    server.close();
    await harness.close();
  }
});
