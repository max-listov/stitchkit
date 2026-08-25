import { describe, expect, test } from 'bun:test';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import type { AgentRuntimeStore } from '../src/agent-runtime';
import {
  AgentMessageSchema,
  AgentRunSchema,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../src/agent-runtime';
import { runAgentStoreConformance } from '../src/testing';

describe('agent runtime store driver', () => {
  test('memory driver passes the reusable production-store contract', async () => {
    await runAgentStoreConformance({
      createStore: createMemoryAgentRuntimeStore,
    });
  });

  test('a store implementing exactly the declared interface survives recover()', async () => {
    // The contract used to demand an unbounded `scanRecoverable()` the runtime
    // never called, while the method `recover()` actually needs was optional —
    // so an adapter written straight from the interface threw at startup.
    // Narrowing to the interface here is the point: nothing extra is in scope.
    const store: AgentRuntimeStore = createMemoryAgentRuntimeStore();
    const runtime = createAgentRuntime({
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
        throw new Error('not used');
      },
      tools: () => ({}),
    });

    expect(await runtime.recover({ resolveContext: () => ({}) })).toEqual([]);
    await runtime.close({ forceTimeoutMs: 1_000 });
  });

  test('bounded recovery resumes queued work and skips a live acquired run by default', async () => {
    const store = createMemoryAgentRuntimeStore();
    const admit = async (conversationId: string) => {
      const input = AgentMessageSchema.parse({
        schemaVersion: 1,
        id: `${conversationId}-input`,
        conversationId,
        role: 'user',
        status: 'committed',
        parts: [{ type: 'text', text: conversationId }],
        createdAt: '2026-08-22T00:00:00.000Z',
        updatedAt: '2026-08-22T00:00:00.000Z',
      });
      const run = AgentRunSchema.parse({
        schemaVersion: 1,
        id: `${conversationId}-run`,
        conversationId,
        inputMessageIds: [input.id],
        assistantMessageId: `${conversationId}-assistant`,
        state: 'queued',
        revision: 0,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      });
      const result = await store.acceptInputAndAssignRun({
        idempotencyKey: `${conversationId}-request`,
        input,
        run,
      });
      if (result.outcome !== 'applied') throw new Error('fixture admission failed');
      return result.snapshot.runs[0];
    };
    const queued = await admit('queued');
    const toAcquire = await admit('acquired');
    if (!queued || !toAcquire) throw new Error('fixture run missing');
    await store.acquireRun({
      conversationId: toAcquire.conversationId,
      runId: toAcquire.id,
      expectedRevision: toAcquire.revision,
      ownerId: 'live-owner',
    });

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
        throw new Error('finish recovered probe');
      },
      tools: () => ({}),
    });
    const outcomes = await runtime.recover({
      resolveContext: () => ({}),
      pageSize: 1,
      maxRuns: 2,
    });
    expect(outcomes).toEqual([
      { conversationId: 'acquired', runId: 'acquired-run', outcome: 'skipped' },
      { conversationId: 'queued', runId: 'queued-run', outcome: 'resumed' },
    ]);
    await runtime.close({ forceTimeoutMs: 1_000 });
  });

  test('does not resume a queued successor while an acquired predecessor is unresolved', async () => {
    const store = createMemoryAgentRuntimeStore();
    const message = (id: string) =>
      AgentMessageSchema.parse({
        schemaVersion: 1,
        id,
        conversationId: 'blocked-lane',
        role: 'user',
        status: 'committed',
        parts: [{ type: 'text', text: id }],
        createdAt: '2026-08-22T00:00:00.000Z',
        updatedAt: '2026-08-22T00:00:00.000Z',
      });
    const admit = async (id: string) => {
      const input = message(`${id}-input`);
      const result = await store.acceptInputAndAssignRun({
        idempotencyKey: id,
        input,
        run: AgentRunSchema.parse({
          schemaVersion: 1,
          id,
          conversationId: 'blocked-lane',
          inputMessageIds: [input.id],
          assistantMessageId: `${id}-assistant`,
          state: 'queued',
          revision: 0,
          createdAt: input.createdAt,
          updatedAt: input.updatedAt,
        }),
      });
      if (result.outcome !== 'applied') throw new Error('fixture admission failed');
      return result.snapshot.runs.find((run) => run.id === id);
    };
    const predecessor = await admit('a-running');
    await admit('z-successor');
    if (!predecessor) throw new Error('fixture predecessor missing');
    await store.acquireRun({
      conversationId: predecessor.conversationId,
      runId: predecessor.id,
      expectedRevision: predecessor.revision,
      ownerId: 'crashed-owner',
    });
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
        throw new Error('must not execute');
      },
      tools: () => ({}),
    });
    expect(await runtime.recover({ resolveContext: () => ({}) })).toEqual([
      {
        conversationId: 'blocked-lane',
        runId: 'a-running',
        outcome: 'skipped',
      },
      {
        conversationId: 'blocked-lane',
        runId: 'z-successor',
        outcome: 'skipped',
      },
    ]);
  });

  test('atomically refuses out-of-order or sibling acquisition', async () => {
    const store = createMemoryAgentRuntimeStore();
    const admit = async (id: string) => {
      const input = AgentMessageSchema.parse({
        schemaVersion: 1,
        id: `${id}-input`,
        conversationId: 'ordered-lane',
        role: 'user',
        status: 'committed',
        parts: [{ type: 'text', text: id }],
        createdAt: '2026-08-22T00:00:00.000Z',
        updatedAt: '2026-08-22T00:00:00.000Z',
      });
      const result = await store.acceptInputAndAssignRun({
        idempotencyKey: id,
        input,
        run: AgentRunSchema.parse({
          schemaVersion: 1,
          id,
          conversationId: input.conversationId,
          inputMessageIds: [input.id],
          assistantMessageId: `${id}-assistant`,
          state: 'queued',
          revision: 0,
          createdAt: input.createdAt,
          updatedAt: input.updatedAt,
        }),
      });
      if (result.outcome !== 'applied') throw new Error('fixture admission failed');
      const run = result.snapshot.runs.find((candidate) => candidate.id === id);
      if (!run) throw new Error('fixture run missing');
      return run;
    };
    const first = await admit('first');
    const second = await admit('second');
    expect(
      await store.acquireRun({
        conversationId: second.conversationId,
        runId: second.id,
        expectedRevision: second.revision,
        ownerId: 'worker-b',
      }),
    ).toMatchObject({ outcome: 'conflict' });
    expect(
      await store.acquireRun({
        conversationId: first.conversationId,
        runId: first.id,
        expectedRevision: first.revision,
        ownerId: 'worker-a',
      }),
    ).toMatchObject({ outcome: 'applied' });
    expect(
      await store.acquireRun({
        conversationId: second.conversationId,
        runId: second.id,
        expectedRevision: second.revision,
        ownerId: 'worker-b',
      }),
    ).toMatchObject({ outcome: 'conflict' });
  });

  test('recovery pagination is tuple-safe and legacy scans deduplicate conversations', async () => {
    const store = createMemoryAgentRuntimeStore();
    const admit = async (conversationId: string, runId: string) => {
      const input = AgentMessageSchema.parse({
        schemaVersion: 1,
        id: `${runId}-input`,
        conversationId,
        role: 'user',
        status: 'committed',
        parts: [{ type: 'text', text: runId }],
        createdAt: '2026-08-22T00:00:00.000Z',
        updatedAt: '2026-08-22T00:00:00.000Z',
      });
      await store.acceptInputAndAssignRun({
        idempotencyKey: `${conversationId}:${runId}`,
        input,
        run: AgentRunSchema.parse({
          schemaVersion: 1,
          id: runId,
          conversationId,
          inputMessageIds: [input.id],
          assistantMessageId: `${runId}-assistant`,
          state: 'queued',
          revision: 0,
          createdAt: input.createdAt,
          updatedAt: input.updatedAt,
        }),
      });
    };
    await admit('a\u0000b', 'c');
    await admit('a', 'b\u0000c');
    for (let index = 0; index < 101; index += 1) {
      await admit('large-conversation', `run-${index.toString().padStart(3, '0')}`);
    }
    const firstPage = await store.scanRecoverable({ limit: 1 });
    expect(firstPage.items).toHaveLength(1);
    const secondPage = await store.scanRecoverable({
      ...(firstPage.nextCursor !== undefined && { cursor: firstPage.nextCursor }),
      limit: 1,
    });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]).not.toEqual(firstPage.items[0]);

    // Walking every page reaches every recoverable run without ever holding
    // the whole set: that is what makes the scan bounded rather than a
    // pagination detail over an unbounded load.
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.scanRecoverable({ ...(cursor && { cursor }), limit: 50 });
      seen.push(...page.items.map((item) => item.conversationId));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(new Set(seen).has('large-conversation')).toBe(true);
  });
});
