import { describe, expect, test } from 'bun:test';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { createBunSqliteAgentRuntimeStore } from '../src/agent-runtime/sqlite-bun';
import {
  AgentProviderStreamCutError,
  agentUsageProjection,
  createAgentProjectionStore,
} from '../src/entrypoints/agent-runtime';
import {
  createUsageTestRuntime,
  reported,
  scriptedModel,
  sdkUsage,
} from './support/agent-usage-projection-fixture';

describe('agentUsageProjection provenance and lifecycle edge cases', () => {
  test('preserves unavailable provenance instead of fabricating zeros or partial cost floors', async () => {
    const sqlite = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    const projections = createAgentProjectionStore({ store: sqlite.store, host: sqlite.host });

    const empty = await projections.advance('conv-empty', agentUsageProjection);
    expect(empty.value).toEqual({
      records: 0,
      usage: {
        inputTokens: { provenance: 'unavailable' },
        outputTokens: { provenance: 'unavailable' },
        reasoningTokens: { provenance: 'unavailable' },
        cacheReadTokens: { provenance: 'unavailable' },
        cacheWriteTokens: { provenance: 'unavailable' },
        cost: { provenance: 'unavailable' },
      },
    });

    const silentRun = createUsageTestRuntime({
      sqlite,
      model: scriptedModel([{ usage: sdkUsage({}) }]),
      withPriceNormalizer: false,
    });
    try {
      await silentRun.submit('conv-silent', 'silent-1', 'hi');
      const silent = await projections.advance('conv-silent', agentUsageProjection);
      expect(silent.value).toEqual({
        records: 1,
        usage: {
          inputTokens: { provenance: 'unavailable' },
          outputTokens: { provenance: 'unavailable' },
          reasoningTokens: { provenance: 'unavailable' },
          cacheReadTokens: { provenance: 'unavailable' },
          cacheWriteTokens: { provenance: 'unavailable' },
          cost: { provenance: 'unavailable' },
        },
      });
    } finally {
      await silentRun.runtime.close();
    }

    const mixedRun = createUsageTestRuntime({
      sqlite,
      model: scriptedModel([
        { usage: sdkUsage({ input: 50, output: 10 }), cost: { value: 0.5, currency: 'USD' } },
        { usage: sdkUsage({ input: 30, output: 20 }) },
        { usage: sdkUsage({ input: 20, output: 5 }), cost: { value: 0.25, currency: 'USD' } },
      ]),
    });
    try {
      for (const key of ['m1', 'm2', 'm3']) await mixedRun.submit('conv-mixed-cost', key);
      const mixed = await projections.advance('conv-mixed-cost', agentUsageProjection);
      expect(mixed.value.records).toBe(3);
      expect(mixed.value.usage.inputTokens).toEqual({ value: 100, provenance: 'computed' });
      expect(mixed.value.usage.outputTokens).toEqual({ value: 35, provenance: 'computed' });
      expect(mixed.value.usage.cost).toEqual({ provenance: 'unavailable' });
    } finally {
      await mixedRun.runtime.close();
    }

    const reversedRun = createUsageTestRuntime({
      sqlite,
      model: scriptedModel([
        { usage: sdkUsage({ input: 10, output: 5 }) },
        { usage: sdkUsage({ input: 20, output: 15 }), cost: { value: 0.5, currency: 'USD' } },
      ]),
    });
    try {
      for (const key of ['r1', 'r2']) await reversedRun.submit('conv-unpriced-first', key);
      const reversed = await projections.advance('conv-unpriced-first', agentUsageProjection);
      expect(reversed.value.records).toBe(2);
      expect(reversed.value.usage.inputTokens).toEqual({ value: 30, provenance: 'computed' });
      expect(reversed.value.usage.outputTokens).toEqual({ value: 20, provenance: 'computed' });
      expect(reversed.value.usage.cost).toEqual({ provenance: 'unavailable' });
    } finally {
      await reversedRun.runtime.close();
    }

    const currencyRun = createUsageTestRuntime({
      sqlite,
      model: scriptedModel([
        { usage: sdkUsage({ input: 10, output: 10 }), cost: { value: 0.5, currency: 'USD' } },
        { usage: sdkUsage({ input: 10, output: 10 }), cost: { value: 0.25, currency: 'EUR' } },
        { usage: sdkUsage({ input: 15, output: 5 }), cost: { value: 0, currency: 'USD' } },
      ]),
    });
    try {
      await currencyRun.submit('conv-currencies', 'c1', 'usd');
      await currencyRun.submit('conv-currencies', 'c2', 'eur');
      const currencies = await projections.advance('conv-currencies', agentUsageProjection);
      expect(currencies.value.usage.cost).toEqual({ provenance: 'unavailable' });

      await currencyRun.submit('conv-free', 'f1', 'free');
      const free = await projections.advance('conv-free', agentUsageProjection);
      expect(free.value.usage.cost).toEqual({
        value: 0,
        currency: 'USD',
        provenance: 'provider-reported',
      });
    } finally {
      await currencyRun.runtime.close();
      await sqlite.close();
    }
  });

  test('treats direct commitRunTerminal without usage as unknownUsage and poisons cost', async () => {
    const sqlite = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    const projections = createAgentProjectionStore({ store: sqlite.store, host: sqlite.host });
    const model = scriptedModel([
      { usage: sdkUsage({ input: 50, output: 20 }), cost: { value: 0.25, currency: 'USD' } },
    ]);
    const { runtime, submit } = createUsageTestRuntime({ sqlite, model });
    try {
      await submit('conv-omitted', 'run-priced', 'first');
      const now = new Date().toISOString();
      await sqlite.store.acceptInputAndAssignRun({
        idempotencyKey: 'direct-key',
        input: {
          schemaVersion: 1,
          id: 'msg-direct-in',
          conversationId: 'conv-omitted',
          role: 'user',
          status: 'committed',
          parts: [{ type: 'text', text: 'second' }],
          createdAt: now,
          updatedAt: now,
        },
        run: {
          schemaVersion: 1,
          id: 'run-direct',
          conversationId: 'conv-omitted',
          inputMessageIds: ['msg-direct-in'],
          assistantMessageId: 'msg-direct-out',
          state: 'queued',
          revision: 0,
          createdAt: now,
          updatedAt: now,
        },
      });
      await sqlite.store.acquireRun({
        conversationId: 'conv-omitted',
        runId: 'run-direct',
        expectedRevision: 0,
        ownerId: 'owner-1',
      });
      await sqlite.store.commitRunTerminal({
        conversationId: 'conv-omitted',
        runId: 'run-direct',
        expectedRevision: 1,
        ownerId: 'owner-1',
        reason: 'success',
        assistant: {
          schemaVersion: 1,
          id: 'msg-direct-out',
          conversationId: 'conv-omitted',
          runId: 'run-direct',
          role: 'assistant',
          status: 'completed',
          parts: [{ type: 'text', text: 'done' }],
          createdAt: now,
          updatedAt: now,
        },
      });

      const projected = await projections.advance('conv-omitted', agentUsageProjection);
      expect(projected.value.records).toBe(2);
      expect(projected.value.usage.inputTokens).toEqual({ value: 50, provenance: 'computed' });
      expect(projected.value.usage.outputTokens).toEqual({
        value: 20,
        provenance: 'computed',
      });
      expect(projected.value.usage.cost).toEqual({ provenance: 'unavailable' });
    } finally {
      await runtime.close();
      await sqlite.close();
    }
  });

  test('does not poison conversation cost on pre-provider context_overflow', async () => {
    const sqlite = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    const projections = createAgentProjectionStore({ store: sqlite.store, host: sqlite.host });
    let call = 0;
    const { runtime, submit } = createUsageTestRuntime({
      sqlite,
      model: scriptedModel([
        { usage: sdkUsage({ input: 80, output: 20 }), cost: { value: 0.25, currency: 'USD' } },
      ]),
      contextDecision: () => (++call === 1 ? 'fits' : 'oversized'),
    });
    try {
      expect((await submit('conv-overflow', 'ov-1', 'fits')).reason).toBe('success');
      expect((await submit('conv-overflow', 'ov-2', 'too big')).reason).toBe(
        'context_overflow',
      );

      const projected = await projections.advance('conv-overflow', agentUsageProjection);
      expect(projected.value).toEqual({
        records: 1,
        usage: {
          inputTokens: { value: 80, provenance: 'computed' },
          outputTokens: { value: 20, provenance: 'computed' },
          reasoningTokens: { provenance: 'unavailable' },
          cacheReadTokens: { provenance: 'unavailable' },
          cacheWriteTokens: { provenance: 'unavailable' },
          cost: { value: 0.25, currency: 'USD', provenance: 'provider-reported' },
        },
      });
    } finally {
      await runtime.close();
      await sqlite.close();
    }
  });

  test('a provider that never answered leaves the paid runs of the conversation priced', async () => {
    // A refused connection and an error before any output are runs nobody was billed for.
    // The paid run before them and the paid run after them still add up to a price.
    const sqlite = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    const projections = createAgentProjectionStore({ store: sqlite.store, host: sqlite.host });
    const paid = scriptedModel([
      { usage: sdkUsage({ input: 80, output: 20 }), cost: { value: 0.25, currency: 'USD' } },
      { usage: sdkUsage({ input: 40, output: 10 }), cost: { value: 0.5, currency: 'USD' } },
    ]);
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        call += 1;
        if (call === 2) throw new Error('connect refused');
        if (call === 3) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'response-metadata', id: 'resp-empty', modelId: 'priced-model' },
                { type: 'error', error: new Error('upstream unavailable') },
              ],
            }),
          };
        }
        return paid.doStream(options);
      },
    });
    const { runtime, submit } = createUsageTestRuntime({ sqlite, model });
    try {
      expect((await submit('conv-refused', 'rf-1', 'paid')).reason).toBe('success');
      expect((await submit('conv-refused', 'rf-2', 'refused')).reason).toBe(
        'provider_failure',
      );
      expect((await submit('conv-refused', 'rf-3', 'empty')).reason).toBe('provider_failure');
      expect((await submit('conv-refused', 'rf-4', 'paid again')).reason).toBe('success');

      const projected = await projections.advance('conv-refused', agentUsageProjection);
      expect(projected.value.records).toBe(2);
      expect(projected.value.usage.inputTokens).toEqual({
        value: 120,
        provenance: 'computed',
      });
      expect(projected.value.usage.cost).toEqual({
        value: 0.75,
        currency: 'USD',
        provenance: 'computed',
      });
    } finally {
      await runtime.close();
      await sqlite.close();
    }
  });

  test('a provider that answered and then failed without a price keeps the cost unknown', async () => {
    // One delta is a provider that spoke. What it charged for the cut answer is not known,
    // and the conversation says so instead of showing the earlier price as the whole bill.
    const sqlite = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    const projections = createAgentProjectionStore({ store: sqlite.store, host: sqlite.host });
    const paid = scriptedModel([
      { usage: sdkUsage({ input: 80, output: 20 }), cost: { value: 0.25, currency: 'USD' } },
    ]);
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        call += 1;
        if (call === 1) return paid.doStream(options);
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'response-metadata', id: 'resp-cut', modelId: 'priced-model' },
              { type: 'text-start', id: 't' },
              { type: 'text-delta', id: 't', delta: 'partial' },
              { type: 'error', error: new Error('stream cut') },
            ],
          }),
        };
      },
    });
    const { runtime, submit } = createUsageTestRuntime({ sqlite, model });
    try {
      expect((await submit('conv-cut', 'cut-1', 'paid')).reason).toBe('success');
      expect((await submit('conv-cut', 'cut-2', 'cut')).reason).toBe('provider_failure');

      const projected = await projections.advance('conv-cut', agentUsageProjection);
      expect(projected.value.records).toBe(2);
      expect(projected.value.usage.cost).toEqual({ provenance: 'unavailable' });
    } finally {
      await runtime.close();
      await sqlite.close();
    }
  });

  test('retains step 1 usage when step 2 fails mid-run', async () => {
    const sqlite = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    const projections = createAgentProjectionStore({ store: sqlite.store, host: sqlite.host });
    let step = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        step += 1;
        if (step === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'response-metadata', id: 'resp-ok', modelId: 'priced-model' },
                { type: 'tool-call', toolCallId: 'c1', toolName: 'ping', input: '{}' },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: undefined },
                  usage: sdkUsage({ input: 100, output: 20 }),
                  providerMetadata: { billing: { cost: 0.25, currency: 'USD' } },
                },
              ],
            }),
          };
        }
        throw new Error('step 2 transport failure');
      },
    });
    const { runtime, submit } = createUsageTestRuntime({ sqlite, model });
    try {
      expect((await submit('conv-midfail', 'mf-1', 'run')).reason).toBe('provider_failure');
      const projected = await projections.advance('conv-midfail', agentUsageProjection);
      expect(projected.value).toEqual({
        records: 1,
        usage: {
          inputTokens: { value: 100, provenance: 'provider-reported' },
          outputTokens: { value: 20, provenance: 'provider-reported' },
          reasoningTokens: { provenance: 'unavailable' },
          cacheReadTokens: { provenance: 'unavailable' },
          cacheWriteTokens: { provenance: 'unavailable' },
          cost: { value: 0.25, currency: 'USD', provenance: 'provider-reported' },
        },
      });
    } finally {
      await runtime.close();
      await sqlite.close();
    }
  });

  test('includes retried abandonedUsage and compaction usage without loss or double counting', async () => {
    const sqlite = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    const projections = createAgentProjectionStore({ store: sqlite.store, host: sqlite.host });
    let attempt = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        attempt += 1;
        if (attempt === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'response-metadata', id: 'resp-retry-1', modelId: 'priced-model' },
                { type: 'text-start', id: 't1' },
                { type: 'text-delta', id: 't1', delta: 'partial' },
                { type: 'error', error: new AgentProviderStreamCutError() },
                {
                  type: 'finish',
                  finishReason: { unified: 'error', raw: undefined },
                  usage: sdkUsage({ input: 40, output: 10 }),
                  providerMetadata: { billing: { cost: 0.25, currency: 'USD' } },
                },
              ],
            }),
          };
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'response-metadata', id: 'resp-retry-2', modelId: 'priced-model' },
              { type: 'text-start', id: 't2' },
              { type: 'text-delta', id: 't2', delta: 'recovered' },
              { type: 'text-end', id: 't2' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: undefined },
                usage: sdkUsage({ input: 50, output: 15 }),
                providerMetadata: { billing: { cost: 0.5, currency: 'USD' } },
              },
            ],
          }),
        };
      },
    });
    const { runtime, submit } = createUsageTestRuntime({
      sqlite,
      model,
      retryMaxAttempts: 2,
      compactUsage: {
        inputTokens: reported(30),
        outputTokens: reported(5),
        cost: { value: 0.125, currency: 'USD', provenance: 'provider-reported' },
      },
    });
    try {
      expect((await submit('conv-retry-compact', 'rc-1', 'go')).reason).toBe('success');
      const projected = await projections.advance('conv-retry-compact', agentUsageProjection);
      expect(projected.value).toEqual({
        records: 1,
        usage: {
          inputTokens: { value: 120, provenance: 'computed' },
          outputTokens: { value: 30, provenance: 'computed' },
          reasoningTokens: { provenance: 'unavailable' },
          cacheReadTokens: { provenance: 'unavailable' },
          cacheWriteTokens: { provenance: 'unavailable' },
          cost: { value: 0.875, currency: 'USD', provenance: 'computed' },
        },
      });
    } finally {
      await runtime.close();
      await sqlite.close();
    }
  });

  test('counts checkpointed usage on recoverRun(abandon), skips uncheckpointed abandons, and survives branch', async () => {
    const sqlite = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    const projections = createAgentProjectionStore({ store: sqlite.store, host: sqlite.host });
    const now = new Date().toISOString();
    try {
      // Run 1: acquired, checkpointed with spend, then abandoned.
      await sqlite.store.acceptInputAndAssignRun({
        idempotencyKey: 'ab-1',
        input: {
          schemaVersion: 1,
          id: 'in-1',
          conversationId: 'conv-abandon',
          role: 'user',
          status: 'committed',
          parts: [{ type: 'text', text: 'first' }],
          createdAt: now,
          updatedAt: now,
        },
        run: {
          schemaVersion: 1,
          id: 'run-ab-1',
          conversationId: 'conv-abandon',
          inputMessageIds: ['in-1'],
          assistantMessageId: 'out-1',
          state: 'queued',
          revision: 0,
          createdAt: now,
          updatedAt: now,
        },
      });
      await sqlite.store.acquireRun({
        conversationId: 'conv-abandon',
        runId: 'run-ab-1',
        expectedRevision: 0,
        ownerId: 'dead-worker',
      });
      await sqlite.store.checkpointRunAssistant({
        conversationId: 'conv-abandon',
        runId: 'run-ab-1',
        expectedRevision: 1,
        ownerId: 'dead-worker',
        assistant: {
          schemaVersion: 1,
          id: 'out-1',
          conversationId: 'conv-abandon',
          runId: 'run-ab-1',
          role: 'assistant',
          status: 'streaming',
          parts: [{ type: 'text', text: 'partial' }],
          createdAt: now,
          updatedAt: now,
        },
        usage: {
          inputTokens: reported(70),
          outputTokens: reported(25),
          cost: { value: 0.25, currency: 'USD', provenance: 'provider-reported' },
        },
      });
      await sqlite.store.recoverRun({
        conversationId: 'conv-abandon',
        runId: 'run-ab-1',
        expectedRevision: 2,
        action: 'abandon',
      });

      // Run 2: queued and abandoned before any checkpoint/spend — must not poison Run 1's cost.
      await sqlite.store.acceptInputAndAssignRun({
        idempotencyKey: 'ab-2',
        input: {
          schemaVersion: 1,
          id: 'in-2',
          conversationId: 'conv-abandon',
          role: 'user',
          status: 'committed',
          parts: [{ type: 'text', text: 'second' }],
          createdAt: now,
          updatedAt: now,
        },
        run: {
          schemaVersion: 1,
          id: 'run-ab-2',
          conversationId: 'conv-abandon',
          inputMessageIds: ['in-2'],
          assistantMessageId: 'out-2',
          state: 'queued',
          revision: 0,
          createdAt: now,
          updatedAt: now,
        },
      });
      await sqlite.store.recoverRun({
        conversationId: 'conv-abandon',
        runId: 'run-ab-2',
        expectedRevision: 0,
        action: 'abandon',
      });

      const projected = await projections.advance('conv-abandon', agentUsageProjection);
      expect(projected.value).toEqual({
        records: 1,
        usage: {
          inputTokens: { value: 70, provenance: 'provider-reported' },
          outputTokens: { value: 25, provenance: 'provider-reported' },
          reasoningTokens: { provenance: 'unavailable' },
          cacheReadTokens: { provenance: 'unavailable' },
          cacheWriteTokens: { provenance: 'unavailable' },
          cost: { value: 0.25, currency: 'USD', provenance: 'provider-reported' },
        },
      });

      // Branching the conversation preserves abandoned run usage on the branch ledger too.
      if (!sqlite.store.branchConversation) throw new Error('expected branchConversation');
      await sqlite.store.branchConversation({
        requestKey: 'branch-abandon-1',
        source: {
          kind: 'conversation',
          conversationId: 'conv-abandon',
          throughRunId: 'run-ab-1',
        },
        destinationConversationId: 'conv-abandon-branch',
      });
      const branched = await projections.advance('conv-abandon-branch', agentUsageProjection);
      expect(branched.value).toEqual(projected.value);
    } finally {
      await sqlite.close();
    }
  });
});
