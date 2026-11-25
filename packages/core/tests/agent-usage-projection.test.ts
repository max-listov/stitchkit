import { describe, expect, test } from 'bun:test';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { createBunSqliteAgentRuntimeStore } from '../src/agent-runtime/sqlite-bun';
import {
  agentUsageProjection,
  createAgentProjectionStore,
} from '../src/entrypoints/agent-runtime';
import {
  createUsageTestRuntime,
  scriptedModel,
  sdkUsage,
} from './support/agent-usage-projection-fixture';

function twoStepToolModel() {
  let step = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      step += 1;
      if (step === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'response-metadata', id: 'resp-step-1', modelId: 'priced-model' },
              { type: 'tool-call', toolCallId: 'call-1', toolName: 'ping', input: '{}' },
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
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'response-metadata', id: 'resp-step-2', modelId: 'priced-model' },
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: 'done' },
            { type: 'text-end', id: 't' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: undefined },
              usage: sdkUsage({ input: 150, output: 30 }),
              providerMetadata: { billing: { cost: 0.5, currency: 'USD' } },
            },
          ],
        }),
      };
    },
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'completed' }],
      usage: sdkUsage({ input: 60, output: 15 }),
      warnings: [],
      finishReason: { unified: 'stop', raw: undefined },
      providerMetadata: { billing: { cost: 0.125, currency: 'USD' } },
    }),
  });
}

describe('agentUsageProjection', () => {
  test('folds real runtime runs into non-zero tokens and cost with honest provenance', async () => {
    const sqlite = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    const projections = createAgentProjectionStore({ store: sqlite.store, host: sqlite.host });
    const model = scriptedModel([
      {
        usage: sdkUsage({
          input: 120,
          output: 45,
          reasoning: 10,
          cacheRead: 20,
          cacheWrite: 5,
        }),
        cost: { value: 0.25, currency: 'USD' },
      },
      {
        usage: sdkUsage({ input: 80, output: 35 }),
        cost: { value: 0.5, currency: 'USD' },
      },
    ]);
    const { runtime, submit } = createUsageTestRuntime({ sqlite, model });
    try {
      expect((await submit('conv-runs', 'run-1', 'turn 1')).reason).toBe('success');

      const afterFirst = await projections.advance('conv-runs', agentUsageProjection);
      expect(afterFirst.version).toBe(2);
      expect(afterFirst.uptoSeq).toBeGreaterThan(0);
      expect(afterFirst.value).toEqual({
        records: 1,
        usage: {
          inputTokens: { value: 120, provenance: 'computed' },
          outputTokens: { value: 45, provenance: 'computed' },
          reasoningTokens: { value: 10, provenance: 'computed' },
          cacheReadTokens: { value: 20, provenance: 'computed' },
          cacheWriteTokens: { value: 5, provenance: 'computed' },
          cost: { value: 0.25, currency: 'USD', provenance: 'provider-reported' },
        },
      });

      expect((await submit('conv-runs', 'run-2', 'turn 2')).reason).toBe('success');

      const afterSecond = await projections.advance('conv-runs', agentUsageProjection);
      expect(afterSecond.uptoSeq).toBeGreaterThan(afterFirst.uptoSeq);
      expect(afterSecond.value).toEqual({
        records: 2,
        usage: {
          inputTokens: { value: 200, provenance: 'computed' },
          outputTokens: { value: 80, provenance: 'computed' },
          reasoningTokens: { value: 10, provenance: 'computed' },
          cacheReadTokens: { value: 20, provenance: 'computed' },
          cacheWriteTokens: { value: 5, provenance: 'computed' },
          cost: { value: 0.75, currency: 'USD', provenance: 'computed' },
        },
      });
    } finally {
      await runtime.close();
      await sqlite.close();
    }
  });

  test('does not double-count checkpoints on a multi-step tool run', async () => {
    const sqlite = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    const projections = createAgentProjectionStore({ store: sqlite.store, host: sqlite.host });
    const { runtime, submit } = createUsageTestRuntime({ sqlite, model: twoStepToolModel() });
    try {
      expect((await submit('conv-multistep', 'multi-1', 'call ping')).reason).toBe('success');

      const events = await sqlite.store.readEvents({
        conversationId: 'conv-multistep',
        limit: 100,
      });
      const checkpoints = events.items.filter(
        (event) =>
          event.kind === 'runtime/transition' &&
          z.object({ type: z.literal('checkpoint') }).safeParse(event.payload).success,
      );
      expect(checkpoints.length).toBeGreaterThan(0);

      const projected = await projections.advance('conv-multistep', agentUsageProjection);
      expect(projected.value).toEqual({
        records: 1,
        usage: {
          inputTokens: { value: 250, provenance: 'computed' },
          outputTokens: { value: 50, provenance: 'computed' },
          reasoningTokens: { provenance: 'unavailable' },
          cacheReadTokens: { provenance: 'unavailable' },
          cacheWriteTokens: { provenance: 'unavailable' },
          cost: { value: 0.75, currency: 'USD', provenance: 'computed' },
        },
      });
    } finally {
      await runtime.close();
      await sqlite.close();
    }
  });

  test('does not double-count multi-step audited runs and still counts standalone completions', async () => {
    const sqlite = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    const projections = createAgentProjectionStore({ store: sqlite.store, host: sqlite.host });
    const { runtime, ledger, submit } = createUsageTestRuntime({
      sqlite,
      model: twoStepToolModel(),
      withInvocations: true,
    });
    if (!ledger) throw new Error('expected invocation ledger');
    try {
      expect((await submit('conv-audited', 'audited-1', 'call ping')).reason).toBe('success');

      const events = await sqlite.store.readEvents({
        conversationId: 'conv-audited',
        limit: 100,
      });
      const providerResponses = events.items.filter(
        (event) => event.kind === 'provider/response',
      );
      expect(providerResponses.length).toBe(2);

      const afterAgent = await projections.advance('conv-audited', agentUsageProjection);
      expect(afterAgent.value).toEqual({
        records: 1,
        usage: {
          inputTokens: { value: 250, provenance: 'computed' },
          outputTokens: { value: 50, provenance: 'computed' },
          reasoningTokens: { provenance: 'unavailable' },
          cacheReadTokens: { provenance: 'unavailable' },
          cacheWriteTokens: { provenance: 'unavailable' },
          cost: { value: 0.75, currency: 'USD', provenance: 'computed' },
        },
      });

      const completion = await ledger.complete(
        {
          conversationId: 'conv-standalone',
          idempotencyKey: 'comp-1',
          trace: { operationId: 'op-2', project: 'proj', purpose: 'complete' },
          models: ['priced'],
          prompt: 'hello',
          timeoutMs: 5_000,
        },
        {},
      );
      expect(completion.outcome).toBe('succeeded');

      const standalone = await projections.advance('conv-standalone', agentUsageProjection);
      expect(standalone.value).toEqual({
        records: 1,
        usage: {
          inputTokens: { value: 60, provenance: 'provider-reported' },
          outputTokens: { value: 15, provenance: 'provider-reported' },
          reasoningTokens: { provenance: 'unavailable' },
          cacheReadTokens: { provenance: 'unavailable' },
          cacheWriteTokens: { provenance: 'unavailable' },
          cost: { value: 0.125, currency: 'USD', provenance: 'provider-reported' },
        },
      });
    } finally {
      await runtime.close();
      await sqlite.close();
    }
  });

  test('skips failed fallback attempt without usage in ledger.complete', async () => {
    const sqlite = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    const projections = createAgentProjectionStore({ store: sqlite.store, host: sqlite.host });
    const brokenModel = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('upstream 503');
      },
    });
    const { runtime, ledger } = createUsageTestRuntime({
      sqlite,
      model: twoStepToolModel(),
      extraModels: { broken: brokenModel },
      withInvocations: true,
    });
    if (!ledger) throw new Error('expected invocation ledger');
    try {
      const result = await ledger.complete(
        {
          conversationId: 'conv-fallback',
          idempotencyKey: 'fb-1',
          trace: { operationId: 'op-fb', project: 'proj', purpose: 'fallback' },
          models: ['broken', 'priced'],
          prompt: 'hello',
          timeoutMs: 5_000,
        },
        {},
      );
      expect(result.outcome).toBe('succeeded');

      const events = await sqlite.store.readEvents({
        conversationId: 'conv-fallback',
        limit: 100,
      });
      const responses = events.items.filter((event) => event.kind === 'provider/response');
      expect(responses.length).toBe(2);

      const projected = await projections.advance('conv-fallback', agentUsageProjection);
      expect(projected.value).toEqual({
        records: 1,
        usage: {
          inputTokens: { value: 60, provenance: 'provider-reported' },
          outputTokens: { value: 15, provenance: 'provider-reported' },
          reasoningTokens: { provenance: 'unavailable' },
          cacheReadTokens: { provenance: 'unavailable' },
          cacheWriteTokens: { provenance: 'unavailable' },
          cost: { value: 0.125, currency: 'USD', provenance: 'provider-reported' },
        },
      });
    } finally {
      await runtime.close();
      await sqlite.close();
    }
  });

  test('re-folds stale version 1 rows on advance and excludes them from projections.list', async () => {
    const sqlite = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    const projections = createAgentProjectionStore({ store: sqlite.store, host: sqlite.host });
    const model = scriptedModel([
      { usage: sdkUsage({ input: 42, output: 13 }), cost: { value: 0.125, currency: 'USD' } },
    ]);
    const { runtime, submit } = createUsageTestRuntime({ sqlite, model });
    try {
      await submit('conv-upgrade', 'u1', 'hi');
      const events = await sqlite.store.readEvents({
        conversationId: 'conv-upgrade',
        limit: 100,
      });
      const lastSeq = events.items.at(-1)?.seq ?? 0;
      expect(lastSeq).toBeGreaterThan(0);

      await sqlite.host.transaction('conv-upgrade', (scope) =>
        scope.run(
          `INSERT INTO ${sqlite.host.tables.projections}
             (conversation_id, name, version, upto_seq, payload, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            'conv-upgrade',
            agentUsageProjection.name,
            1,
            lastSeq,
            JSON.stringify({ inputTokens: 0, outputTokens: 0, cost: 0, sources: [] }),
            new Date(0).toISOString(),
          ],
        ),
      );

      expect(await projections.load('conv-upgrade', agentUsageProjection)).toBeUndefined();
      expect(await projections.list(agentUsageProjection)).toEqual([]);

      const rebuilt = await projections.advance('conv-upgrade', agentUsageProjection);
      expect(rebuilt.version).toBe(2);
      expect(rebuilt.uptoSeq).toBe(lastSeq);
      expect(rebuilt.value.records).toBe(1);
      expect(rebuilt.value.usage.inputTokens).toEqual({ value: 42, provenance: 'computed' });
      expect(rebuilt.value.usage.outputTokens).toEqual({ value: 13, provenance: 'computed' });
      expect(rebuilt.value.usage.cost).toEqual({
        value: 0.125,
        currency: 'USD',
        provenance: 'provider-reported',
      });
      expect(await projections.list(agentUsageProjection)).toEqual([
        { conversationId: 'conv-upgrade', projection: rebuilt },
      ]);
    } finally {
      await runtime.close();
      await sqlite.close();
    }
  });
});
