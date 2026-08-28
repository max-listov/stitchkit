import { describe, expect, test } from 'bun:test';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  AgentMessageSchema,
  AgentRunSchema,
  type AgentRuntimeStore,
  type AgentSnapshot,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
  structuredCompaction,
} from '../src/agent-runtime';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

const descriptor = {
  provider: 'test',
  modelId: 'queue-isolation',
  contextWindow: 10_000,
  capabilities: [],
};

const protocol = defineAgentProtocol({
  context: z.object({}),
  inputMetadata: z.object({}),
});

function submit(
  runtime: ReturnType<typeof createAgentRuntime>,
  idempotencyKey: string,
  text: string,
) {
  return runtime.submit({
    conversationId: 'queue-isolation',
    idempotencyKey,
    context: {},
    parts: [{ type: 'text', text }],
    metadata: {},
  });
}

describe('queued inputs cross the provider boundary only with their assigned run', () => {
  test.each([
    ['distinct timestamps', ['2026-08-28T00:00:00.000Z', '2026-08-28T00:00:01.000Z']],
    ['equal timestamps', ['2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z']],
  ])('recovery restores causal order across pages with %s', async (_label, timestamps) => {
    const store = createMemoryAgentRuntimeStore();
    const conversationId = `recovery-${_label.replace(' ', '-')}`;
    for (const [index, id] of ['z', 'a'].entries()) {
      const createdAt = timestamps[index];
      if (!createdAt) throw new Error('fixture timestamp missing');
      const input = AgentMessageSchema.parse({
        schemaVersion: 1,
        id: `${id}-input`,
        conversationId,
        role: 'user',
        status: 'committed',
        parts: [{ type: 'text', text: `INPUT_${id}` }],
        createdAt,
        updatedAt: createdAt,
      });
      await store.acceptInputAndAssignRun({
        idempotencyKey: id,
        input,
        run: AgentRunSchema.parse({
          schemaVersion: 1,
          id,
          conversationId,
          inputMessageIds: [input.id],
          assistantMessageId: `${id}-assistant`,
          state: 'queued',
          revision: 0,
          createdAt,
          updatedAt: createdAt,
        }),
      });
    }

    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        call += 1;
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: `text-${call}` },
              { type: 'text-delta', id: `text-${call}`, delta: `ANSWER_${call}` },
              { type: 'text-end', id: `text-${call}` },
              { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
            ],
          }),
        };
      },
    });
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
      tools: () => ({}),
    });

    const outcomes = await runtime.recover({
      resolveContext: () => ({}),
      pageSize: 1,
    });
    expect(outcomes.map(({ runId, outcome }) => ({ runId, outcome }))).toEqual([
      { runId: 'z', outcome: 'resumed' },
      { runId: 'a', outcome: 'resumed' },
    ]);
    await Promise.all(
      outcomes.map((outcome) => {
        if (!outcome.result) throw new Error('resumed recovery did not expose its result');
        return outcome.result;
      }),
    );

    expect(model.doStreamCalls).toHaveLength(2);
    const firstPrompt = JSON.stringify(model.doStreamCalls[0]?.prompt ?? []);
    const secondPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt ?? []);
    expect(firstPrompt).toContain('INPUT_z');
    expect(firstPrompt).not.toContain('INPUT_a');
    expect(secondPrompt).toContain('INPUT_z');
    expect(secondPrompt).toContain('ANSWER_1');
    expect(secondPrompt).toContain('INPUT_a');
    expect((await store.loadSnapshot(conversationId)).runs.map((run) => run.state)).toEqual([
      'completed',
      'completed',
    ]);
    await runtime.close({ forceTimeoutMs: 1_000 });
  });

  test('an admission during predecessor acquisition stays out of its prompt and follows its answer', async () => {
    const durable = createMemoryAgentRuntimeStore();
    const acquiring = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let firstAcquisition = true;
    const store: AgentRuntimeStore = {
      ...durable,
      async acquireRun(input) {
        if (firstAcquisition) {
          firstAcquisition = false;
          acquiring.resolve();
          await release.promise;
        }
        return durable.acquireRun(input);
      },
    };
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        call += 1;
        const answer = `ANSWER_${call}`;
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: `text-${call}` },
              { type: 'text-delta', id: `text-${call}`, delta: answer },
              { type: 'text-end', id: `text-${call}` },
              { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
            ],
          }),
        };
      },
    });
    const promptSnapshots: AgentSnapshot[] = [];
    const runtime = createAgentRuntime({
      protocol,
      store,
      models: { resolve: () => ({ descriptor, model }) },
      prompt: ({ snapshot }) => {
        promptSnapshots.push(snapshot);
        return {
          instructions: 'test',
          sections: [],
          instructionTokens: { provenance: 'unavailable' },
          contextDecision: 'unavailable',
        };
      },
      tools: () => ({}),
      runs: { inputPolicy: 'queue' },
    });

    const first = submit(runtime, 'first', 'FIRST_INPUT');
    await acquiring.promise;
    const second = submit(runtime, 'second', 'SECOND_QUEUED_INPUT');
    await second.accepted;
    release.resolve();

    const [firstResult, secondResult] = await Promise.all([first.result, second.result]);
    expect(firstResult.run.inputMessageIds).toHaveLength(1);
    expect(secondResult.run.inputMessageIds).toHaveLength(1);

    const firstPrompt = JSON.stringify(model.doStreamCalls[0]?.prompt ?? []);
    const secondPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt ?? []);
    expect(firstPrompt).toContain('FIRST_INPUT');
    expect(firstPrompt).not.toContain('SECOND_QUEUED_INPUT');
    expect(secondPrompt).toContain('FIRST_INPUT');
    expect(secondPrompt).toContain('ANSWER_1');
    expect(secondPrompt).toContain('SECOND_QUEUED_INPUT');
    expect(secondPrompt.indexOf('FIRST_INPUT')).toBeLessThan(secondPrompt.indexOf('ANSWER_1'));
    expect(secondPrompt.indexOf('ANSWER_1')).toBeLessThan(
      secondPrompt.indexOf('SECOND_QUEUED_INPUT'),
    );

    expect(JSON.stringify(promptSnapshots[0]?.messages ?? [])).not.toContain(
      'SECOND_QUEUED_INPUT',
    );
    expect(JSON.stringify(promptSnapshots[1]?.messages ?? [])).toContain(
      'SECOND_QUEUED_INPUT',
    );
    const [firstInputId] = firstResult.run.inputMessageIds;
    const [secondInputId] = secondResult.run.inputMessageIds;
    if (!firstInputId || !secondInputId) throw new Error('fixture input identity missing');
    const canonical = await store.loadSnapshot('queue-isolation');
    expect(canonical.messages.map((message) => message.id)).toEqual([
      firstInputId,
      firstResult.message.id,
      secondInputId,
      secondResult.message.id,
    ]);
    const compact = structuredCompaction({
      schema: z.object({ ids: z.array(z.string()) }),
      keepRecentTurns: 1,
      threshold: () => true,
      summarize: ({ eligibleMessages }) => ({
        ids: eligibleMessages.map((message) => message.id),
      }),
      createSummaryMessage: ({ conversationId, summary }) => ({
        schemaVersion: 1,
        id: 'queue-summary',
        conversationId,
        role: 'summary',
        status: 'committed',
        parts: [{ type: 'text', text: summary.ids.join(',') }],
        createdAt: '2026-08-28T00:00:00.000Z',
        updatedAt: '2026-08-28T00:00:00.000Z',
      }),
    });
    const compacted = await compact({
      conversationId: 'queue-isolation',
      store,
      signal: new AbortController().signal,
    });
    expect(compacted.outcome).toBe('applied');
    expect(compacted.snapshot.messages.map((message) => message.id)).toEqual([
      'queue-summary',
      secondInputId,
      secondResult.message.id,
    ]);
    await runtime.close();
  });
});
