import { describe, expect, test } from 'bun:test';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
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
