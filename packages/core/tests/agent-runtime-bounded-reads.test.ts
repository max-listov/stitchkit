import { describe, expect, test } from 'bun:test';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  type AgentRuntimeStore,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../src/agent-runtime';

/**
 * Counts every read, so a claim about which one the runtime uses is a number
 * rather than a reading of the source.
 */
function countingStore(inner: AgentRuntimeStore) {
  const counts = { loadSnapshot: 0, loadRun: 0, listActiveRuns: 0 };
  const store: AgentRuntimeStore = {
    ...inner,
    loadSnapshot(conversationId) {
      counts.loadSnapshot += 1;
      return inner.loadSnapshot(conversationId);
    },
    loadRun(request) {
      counts.loadRun += 1;
      return inner.loadRun(request);
    },
    listActiveRuns(conversationId) {
      counts.listActiveRuns += 1;
      return inner.listActiveRuns(conversationId);
    },
  };
  return { store, counts };
}

const runtimeOver = (
  store: AgentRuntimeStore,
  tools: () => Record<string, never> = () => ({}),
) =>
  createAgentRuntime({
    protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
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
      throw new Error('bounded-read fixture');
    },
    tools,
  });

describe('a run is read without its conversation', () => {
  test('a whole turn reads the conversation once, and the run by id', async () => {
    const { store, counts } = countingStore(createMemoryAgentRuntimeStore());
    const runtime = runtimeOver(store);
    await runtime
      .submit({
        conversationId: 'bounded-1',
        idempotencyKey: 'input-1',
        context: {},
        parts: [{ type: 'text', text: 'hello' }],
        metadata: {},
      })
      .result.catch(() => undefined);
    // The prompt is built from the mutation's own snapshot, so a run that never
    // reaches the provider needs no conversation read at all. Every lookup it
    // does perform is a run lookup.
    expect(counts.loadSnapshot).toBe(0);
    expect(counts.loadRun).toBeGreaterThan(0);
  });

  test('interrupting a run reads the run, not the conversation', async () => {
    const inner = createMemoryAgentRuntimeStore();
    const { store, counts } = countingStore(inner);
    const runtime = runtimeOver(store);
    const ticket = runtime.submit({
      conversationId: 'bounded-2',
      idempotencyKey: 'input-1',
      context: {},
      parts: [{ type: 'text', text: 'hello' }],
      metadata: {},
    });
    const admission = await ticket.admission;
    await ticket.result.catch(() => undefined);
    const before = counts.loadSnapshot;
    await runtime
      .interrupt({ conversationId: 'bounded-2', runId: admission.runId })
      .catch(() => undefined);
    expect(counts.loadSnapshot).toBe(before);
  });

  test('loadRun resolves the runId that admission handed back', async () => {
    const store = createMemoryAgentRuntimeStore();
    const runtime = runtimeOver(store);
    const ticket = runtime.submit({
      conversationId: 'bounded-3',
      idempotencyKey: 'input-1',
      context: {},
      parts: [{ type: 'text', text: 'hello' }],
      metadata: {},
    });
    const admission = await ticket.admission;
    await ticket.result.catch(() => undefined);
    const view = await store.loadRun({
      conversationId: 'bounded-3',
      runId: admission.runId,
    });
    expect(view?.run.id).toBe(admission.runId);
    expect(view?.run.terminalReason).toBe('provider_failure');
    // The answer comes back with the run, which is what makes this enough for
    // the terminal path's conflict retry.
    expect(view?.assistant?.id).toBe(admission.assistantMessageId);
    expect(view?.snapshotVersion).toBeGreaterThan(0);
  });

  test('loadRun refuses to cross a conversation boundary', async () => {
    const store = createMemoryAgentRuntimeStore();
    const runtime = runtimeOver(store);
    const ticket = runtime.submit({
      conversationId: 'bounded-4',
      idempotencyKey: 'input-1',
      context: {},
      parts: [{ type: 'text', text: 'hello' }],
      metadata: {},
    });
    const admission = await ticket.admission;
    await ticket.result.catch(() => undefined);
    expect(
      await store.loadRun({ conversationId: 'bounded-other', runId: admission.runId }),
    ).toBeUndefined();
    expect(
      await store.loadRun({ conversationId: 'bounded-4', runId: 'nope' }),
    ).toBeUndefined();
  });

  test('listActiveRuns empties as the run settles', async () => {
    const store = createMemoryAgentRuntimeStore();
    const runtime = runtimeOver(store);
    const ticket = runtime.submit({
      conversationId: 'bounded-5',
      idempotencyKey: 'input-1',
      context: {},
      parts: [{ type: 'text', text: 'hello' }],
      metadata: {},
    });
    await ticket.admission;
    await ticket.result.catch(() => undefined);
    expect(await store.listActiveRuns('bounded-5')).toEqual([]);
    expect(await store.listActiveRuns('never-existed')).toEqual([]);
  });
});

describe('a terminal commit that can never win gives up', () => {
  test('a store that conflicts forever is refused, not spun on', async () => {
    const durable = createMemoryAgentRuntimeStore();
    let conflicts = 0;
    const store: AgentRuntimeStore = {
      ...durable,
      async commitRunTerminal(request) {
        conflicts += 1;
        const snapshot = await durable.loadSnapshot(request.conversationId);
        return { outcome: 'conflict', actualVersion: snapshot.version };
      },
    };
    const runtime = runtimeOver(store);
    await expect(
      runtime.submit({
        conversationId: 'terminal-livelock',
        idempotencyKey: 'input-1',
        context: {},
        parts: [{ type: 'text', text: 'hello' }],
        metadata: {},
      }).result,
    ).rejects.toThrow('terminal commit');
    // Bounded, and the bound is small enough that a real contention storm still
    // resolves inside it.
    expect(conflicts).toBeLessThanOrEqual(32);
    expect(conflicts).toBeGreaterThan(1);
  });
});
