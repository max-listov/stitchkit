import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createAgentRaceBarrier } from '../src/agent-runtime/testing';
import {
  AgentMessageSchema,
  type AgentModelDescriptor,
  AgentRunSchema,
  type AgentRuntimeStore,
  type AgentStepSpend,
  type AgentUsage,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
  structuredCompaction,
} from '../src/entrypoints/agent-runtime';
import { createScriptedModelDriver } from '../src/entrypoints/agent-runtime/testing';
import { defineAgentTool } from '../src/entrypoints/tools';

const timestamp = '2026-08-22T00:00:00.000Z';

async function appendCompletedTurn(store: AgentRuntimeStore, index: number): Promise<void> {
  const input = AgentMessageSchema.parse({
    schemaVersion: 1,
    id: `input-${index}`,
    conversationId: 'conversation-1',
    role: 'user',
    status: 'committed',
    parts: [{ type: 'text', text: `question ${index}` }],
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const run = AgentRunSchema.parse({
    schemaVersion: 1,
    id: `run-${index}`,
    conversationId: 'conversation-1',
    inputMessageIds: [input.id],
    assistantMessageId: `assistant-${index}`,
    state: 'queued',
    revision: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await store.acceptInputAndAssignRun({ idempotencyKey: `request-${index}`, input, run });
  const acquired = await store.acquireRun({
    conversationId: 'conversation-1',
    runId: run.id,
    expectedRevision: 0,
    ownerId: 'test-runtime',
  });
  if (acquired.outcome !== 'applied') throw new Error('fixture run was not acquired');
  const current = acquired.snapshot.runs.find((candidate) => candidate.id === run.id);
  if (!current) throw new Error('fixture run missing');
  await store.commitRunTerminal({
    conversationId: 'conversation-1',
    runId: run.id,
    expectedRevision: current.revision,
    ownerId: 'test-runtime',
    assistant: AgentMessageSchema.parse({
      schemaVersion: 1,
      id: run.assistantMessageId,
      conversationId: 'conversation-1',
      runId: run.id,
      role: 'assistant',
      status: 'completed',
      parts: [{ type: 'text', text: `answer ${index}` }],
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
    reason: 'success',
  });
}

describe('structured agent compaction', () => {
  test('does not apply a stale summary after a concurrent input', async () => {
    const store = createMemoryAgentRuntimeStore();
    await appendCompletedTurn(store, 1);
    await appendCompletedTurn(store, 2);
    await appendCompletedTurn(store, 3);
    const barrier = createAgentRaceBarrier();
    const compact = structuredCompaction({
      schema: z.object({ summary: z.string() }),
      keepRecentTurns: 1,
      threshold: () => true,
      async summarize() {
        await barrier.wait();
        return { summary: 'old summary' };
      },
      createSummaryMessage: ({ conversationId, summary }) =>
        AgentMessageSchema.parse({
          schemaVersion: 1,
          id: 'summary-1',
          conversationId,
          role: 'summary',
          status: 'committed',
          parts: [{ type: 'text', text: summary.summary }],
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
    });

    const resultPromise = compact({
      conversationId: 'conversation-1',
      store,
      signal: new AbortController().signal,
    });
    await barrier.reached;
    await appendCompletedTurn(store, 4);
    barrier.release();
    const result = await resultPromise;

    expect(result.outcome).toBe('conflict');
    expect(result.attempts).toBe(1);
    const canonical = await store.loadSnapshot('conversation-1');
    expect(canonical.messages.some((message) => message.id === 'summary-1')).toBeFalse();
    expect(canonical.messages).toHaveLength(8);
  });

  test('recomputes from a fresh snapshot after a CAS conflict within a bounded attempt count', async () => {
    const store = createMemoryAgentRuntimeStore();
    await appendCompletedTurn(store, 1);
    await appendCompletedTurn(store, 2);
    await appendCompletedTurn(store, 3);
    const barrier = createAgentRaceBarrier();
    let summaries = 0;
    const compact = structuredCompaction({
      schema: z.object({ summary: z.string() }),
      keepRecentTurns: 1,
      maxAttempts: 2,
      threshold: () => true,
      async summarize({ eligibleMessages }) {
        summaries += 1;
        if (summaries === 1) await barrier.wait();
        return { summary: eligibleMessages.map((message) => message.id).join(',') };
      },
      createSummaryMessage: ({ conversationId, summary }) =>
        AgentMessageSchema.parse({
          schemaVersion: 1,
          id: `summary-${summaries}`,
          conversationId,
          role: 'summary',
          status: 'committed',
          parts: [{ type: 'text', text: summary.summary }],
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
    });
    const pending = compact({
      conversationId: 'conversation-1',
      store,
      signal: new AbortController().signal,
    });
    await barrier.reached;
    await appendCompletedTurn(store, 4);
    barrier.release();
    const result = await pending;

    expect(result.outcome).toBe('applied');
    expect(result.attempts).toBe(2);
    expect(summaries).toBe(2);
    expect(result.snapshot.messages[0]?.id).toBe('summary-2');
  });

  test('leaves canonical history unchanged when summary construction fails', async () => {
    const store = createMemoryAgentRuntimeStore();
    await appendCompletedTurn(store, 1);
    await appendCompletedTurn(store, 2);
    const before = await store.loadSnapshot('conversation-1');
    const compact = structuredCompaction({
      schema: z.object({ summary: z.string() }),
      keepRecentTurns: 1,
      threshold: () => true,
      summarize: () => Promise.reject(new Error('summary unavailable')),
      createSummaryMessage: () => {
        throw new Error('unreachable');
      },
    });

    await expect(
      compact({
        conversationId: 'conversation-1',
        store,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('summary unavailable');
    expect(await store.loadSnapshot('conversation-1')).toEqual(before);
  });

  test('structuredCompaction accepts { summary, usage } across CAS retries, preserves bare { summary } schemas, and rejects invalid usage', async () => {
    const store = createMemoryAgentRuntimeStore();
    await appendCompletedTurn(store, 1);
    await appendCompletedTurn(store, 2);
    await appendCompletedTurn(store, 3);
    const barrier = createAgentRaceBarrier();
    let attemptCount = 0;

    const compact = structuredCompaction({
      schema: z.object({ summary: z.string() }),
      keepRecentTurns: 1,
      maxAttempts: 2,
      threshold: (_snapshot, ctx) => ctx?.model?.contextWindow === 64_000,
      summarize: async ({ model }) => {
        attemptCount += 1;
        expect(model?.modelId).toBe('small-window');
        if (attemptCount === 1) await barrier.wait();
        const usage: AgentUsage = {
          inputTokens: { value: 100 * attemptCount, provenance: 'provider-reported' },
          outputTokens: { value: 20 * attemptCount, provenance: 'provider-reported' },
        };
        return { summary: { summary: `attempt-${attemptCount}` }, usage };
      },
      createSummaryMessage: ({ conversationId, summary }) =>
        AgentMessageSchema.parse({
          schemaVersion: 1,
          id: `summary-${summary.summary}`,
          conversationId,
          role: 'summary',
          status: 'committed',
          parts: [{ type: 'text', text: summary.summary }],
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
    });

    const descriptor: AgentModelDescriptor = {
      provider: 'test',
      modelId: 'small-window',
      contextWindow: 64_000,
      capabilities: [],
    };
    const pending = compact({
      conversationId: 'conversation-1',
      store,
      signal: new AbortController().signal,
      model: descriptor,
    });
    await barrier.reached;
    await appendCompletedTurn(store, 4);
    barrier.release();
    const res = await pending;

    expect(res.outcome).toBe('applied');
    expect(res.attempts).toBe(2);
    expect(res.usage?.inputTokens).toEqual({ value: 300, provenance: 'computed' });
    expect(res.usage?.outputTokens).toEqual({ value: 60, provenance: 'computed' });

    // Negative control: malformed usage inside `{ summary, usage }` is refused instead of silently dropped.
    const badStore = createMemoryAgentRuntimeStore();
    await appendCompletedTurn(badStore, 1);
    await appendCompletedTurn(badStore, 2);
    const badCompact = structuredCompaction({
      schema: z.object({ facts: z.array(z.string()) }),
      keepRecentTurns: 1,
      threshold: () => true,
      summarize: () =>
        JSON.parse('{"summary":{"facts":["a"]},"usage":{"inputTokens":"not-valid"}}'),
      createSummaryMessage: () => {
        throw new Error('unreachable');
      },
    });
    await expect(
      badCompact({
        conversationId: 'conversation-1',
        store: badStore,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(TypeError);
  });

  test('createAgentRuntime passes resolved model, tools, and context into history.compact and records compaction usage', async () => {
    const store = createMemoryAgentRuntimeStore();
    await appendCompletedTurn(store, 1);
    await appendCompletedTurn(store, 2);
    await appendCompletedTurn(store, 3);

    const observedCompactInputs: Array<{
      modelId: string;
      contextWindow: number;
      toolNames: string[];
      tenant: string;
    }> = [];
    const spendFacts: AgentStepSpend[] = [];

    const compact = structuredCompaction({
      schema: z.object({ digest: z.string() }),
      keepRecentTurns: 1,
      threshold: (_snapshot, ctx) => (ctx?.model?.contextWindow ?? 0) <= 100_000,
      summarize: () => ({
        summary: { digest: 'compacted digest' },
        usage: {
          inputTokens: { value: 45, provenance: 'provider-reported' },
          outputTokens: { value: 15, provenance: 'provider-reported' },
        },
      }),
      createSummaryMessage: ({ conversationId, summary }) =>
        AgentMessageSchema.parse({
          schemaVersion: 1,
          id: 'summary-rt',
          conversationId,
          role: 'summary',
          status: 'committed',
          parts: [{ type: 'text', text: summary.digest }],
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
    });

    const driver = createScriptedModelDriver({
      provider: 'test',
      modelId: 'rt-model',
      steps: [
        [
          { type: 'text-delta', id: 't', delta: 'answered' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: {
              inputTokens: { value: 30, provenance: 'provider-reported' },
              outputTokens: { value: 10, provenance: 'provider-reported' },
            },
          },
        ],
      ],
    });

    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({
        context: z.object({ tenant: z.string() }),
        inputMetadata: z.object({}),
      }),
      store,
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'test',
            modelId: 'rt-model',
            contextWindow: 64_000,
            capabilities: [],
          },
          driver,
        }),
      },
      prompt: () => ({
        instructions: 'test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({
        ping: defineAgentTool({
          description: 'ping',
          input: z.object({}),
          execute: async () => 'pong',
        }),
      }),
      history: {
        compact: async (input) => {
          observedCompactInputs.push({
            modelId: input.model.modelId,
            contextWindow: input.model.contextWindow,
            toolNames: Object.keys(input.tools),
            tenant: input.context.tenant,
          });
          return compact(input);
        },
      },
      onStepSpend: (fact) => {
        spendFacts.push(fact);
      },
    });

    const result = await runtime.submit({
      conversationId: 'conversation-1',
      idempotencyKey: 'compact-rt-1',
      context: { tenant: 'acme' },
      parts: [{ type: 'text', text: 'latest question' }],
      metadata: {},
    }).result;
    await runtime.close();

    expect(result.reason).toBe('success');
    expect(observedCompactInputs).toEqual([
      {
        modelId: 'rt-model',
        contextWindow: 64_000,
        toolNames: ['ping'],
        tenant: 'acme',
      },
    ]);
    expect(spendFacts.map((fact) => fact.phase)).toEqual(['compaction', 'step']);
    expect(result.run.usage?.inputTokens).toEqual({ value: 75, provenance: 'computed' });
    expect(result.run.usage?.outputTokens).toEqual({ value: 25, provenance: 'computed' });
  });

  test('structuredCompaction forwards tools and context into threshold and summarize (and leaves threshold context undefined when omitted)', async () => {
    const store = createMemoryAgentRuntimeStore();
    await appendCompletedTurn(store, 1);
    await appendCompletedTurn(store, 2);
    await appendCompletedTurn(store, 3);

    const seenThreshold: Array<{
      modelId?: string;
      toolNames?: string[];
      context?: unknown;
      isUndefined: boolean;
    }> = [];
    const seenSummarize: Array<{
      modelId?: string;
      toolNames?: string[];
      context?: unknown;
    }> = [];

    const compact = structuredCompaction({
      schema: z.object({ digest: z.string() }),
      keepRecentTurns: 1,
      threshold: (_snapshot, ctx) => {
        seenThreshold.push({
          modelId: ctx?.model?.modelId,
          toolNames: ctx?.tools ? Object.keys(ctx.tools) : undefined,
          context: ctx?.context,
          isUndefined: ctx === undefined,
        });
        return ctx !== undefined;
      },
      summarize: (ctx) => {
        seenSummarize.push({
          modelId: ctx.model?.modelId,
          toolNames: ctx.tools ? Object.keys(ctx.tools) : undefined,
          context: ctx.context,
        });
        return { digest: 'summarized with tools & context' };
      },
      createSummaryMessage: ({ conversationId, summary }) =>
        AgentMessageSchema.parse({
          schemaVersion: 1,
          id: 'summary-ctx',
          conversationId,
          role: 'summary',
          status: 'committed',
          parts: [{ type: 'text', text: summary.digest }],
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
    });

    // Negative control: omitting model/tools/context passes `undefined` as threshold's second arg.
    const skipped = await compact({
      conversationId: 'conversation-1',
      store,
      signal: new AbortController().signal,
    });
    expect(skipped.outcome).toBe('not_needed');
    expect(seenThreshold[0]).toEqual({
      modelId: undefined,
      toolNames: undefined,
      context: undefined,
      isUndefined: true,
    });

    // Passing structuredCompaction directly to createAgentRuntime forwards model, tools, and context end-to-end.
    const driver = createScriptedModelDriver({
      provider: 'test',
      modelId: 'm-ctx',
      steps: [
        [
          { type: 'text-delta', id: 't', delta: 'ok' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: {
              inputTokens: { value: 5, provenance: 'provider-reported' },
              outputTokens: { value: 2, provenance: 'provider-reported' },
            },
          },
        ],
      ],
    });
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({
        context: z.object({ workspaceId: z.string() }),
        inputMetadata: z.object({}),
      }),
      store,
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'test',
            modelId: 'm-ctx',
            contextWindow: 32_000,
            capabilities: [],
          },
          driver,
        }),
      },
      prompt: () => ({
        instructions: 'sys',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({
        search: defineAgentTool({
          description: 'search',
          input: z.object({}),
          execute: async () => 'ok',
        }),
      }),
      history: { compact },
    });
    const res = await runtime.submit({
      conversationId: 'conversation-1',
      idempotencyKey: 'k-compact-ctx',
      context: { workspaceId: 'ws-42' },
      parts: [{ type: 'text', text: 'next question' }],
      metadata: {},
    }).result;
    await runtime.close();

    expect(res.reason).toBe('success');
    expect(seenThreshold[1]).toEqual({
      modelId: 'm-ctx',
      toolNames: ['search'],
      context: { workspaceId: 'ws-42' },
      isUndefined: false,
    });
    expect(seenSummarize).toEqual([
      {
        modelId: 'm-ctx',
        toolNames: ['search'],
        context: { workspaceId: 'ws-42' },
      },
    ]);
  });

  test('structuredCompaction reads leading summary via readPreviousSummary and passes it to summarize', async () => {
    const store = createMemoryAgentRuntimeStore();
    await appendCompletedTurn(store, 1);
    await appendCompletedTurn(store, 2);

    const seenPrevious: Array<{ count: number; notes: string[] } | undefined> = [];
    let summarySeq = 0;

    const compact = structuredCompaction({
      schema: z.object({ count: z.number(), notes: z.array(z.string()) }),
      keepRecentTurns: 1,
      threshold: () => true,
      readPreviousSummary: (message) => {
        const text = message.parts.find((p) => p.type === 'text');
        if (text?.type !== 'text') throw new Error('missing text part');
        return JSON.parse(text.text) as { count: number; notes: string[] };
      },
      summarize: ({ previousSummary, eligibleMessages }) => {
        seenPrevious.push(previousSummary);
        return {
          count: (previousSummary?.count ?? 0) + eligibleMessages.length,
          notes: [...(previousSummary?.notes ?? []), `pass-${summarySeq + 1}`],
        };
      },
      createSummaryMessage: ({ conversationId, summary }) => {
        summarySeq += 1;
        return AgentMessageSchema.parse({
          schemaVersion: 1,
          id: `summary-${summarySeq}`,
          conversationId,
          role: 'summary',
          status: 'committed',
          parts: [{ type: 'text', text: JSON.stringify(summary) }],
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      },
    });

    const first = await compact({
      conversationId: 'conversation-1',
      store,
      signal: new AbortController().signal,
    });
    expect(first.outcome).toBe('applied');
    expect(seenPrevious).toEqual([undefined]);

    await appendCompletedTurn(store, 3);
    const second = await compact({
      conversationId: 'conversation-1',
      store,
      signal: new AbortController().signal,
    });
    expect(second.outcome).toBe('applied');
    expect(seenPrevious).toEqual([undefined, { count: 2, notes: ['pass-1'] }]);
    const leading = second.snapshot.messages[0];
    expect(leading?.role).toBe('summary');
    const textPart = leading?.parts.find((p) => p.type === 'text');
    expect(textPart?.type === 'text' ? JSON.parse(textPart.text) : null).toEqual({
      count: 4,
      notes: ['pass-1', 'pass-2'],
    });
  });
});
