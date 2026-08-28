import { describe, expect, test } from 'bun:test';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  AgentMessageSchema,
  AgentRunSchema,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../src/agent-runtime';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

const protocol = defineAgentProtocol({
  context: z.object({}),
  inputMetadata: z.object({ urgent: z.boolean().optional() }),
});

const descriptor = {
  provider: 'test',
  modelId: 'interrupt-priority',
  contextWindow: 10_000,
  capabilities: [],
};

function recordIds(id: string) {
  return {
    inputMessageId: `${id}-input`,
    runId: id,
    assistantMessageId: `${id}-assistant`,
  };
}

describe('durable interrupt-next priority', () => {
  test('runs A then urgent C then ordinary B without leaking B into C', async () => {
    const store = createMemoryAgentRuntimeStore();
    const firstStarted = Promise.withResolvers<void>();
    const prompts: string[] = [];
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async ({ abortSignal, prompt }) => {
        call += 1;
        prompts.push(JSON.stringify(prompt));
        if (call === 1) {
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: 'stream-start', warnings: [] });
                firstStarted.resolve();
                abortSignal?.addEventListener('abort', () => controller.close(), {
                  once: true,
                });
              },
            }),
          };
        }
        const answer = call === 2 ? 'ANSWER_C' : 'ANSWER_B';
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
      runs: {
        coalescePending: true,
        inputPolicy: (input) =>
          typeof input.metadata === 'object' &&
          input.metadata !== null &&
          'urgent' in input.metadata &&
          input.metadata.urgent === true
            ? 'interrupt-next'
            : 'queue',
      },
      now: () => new Date('2026-08-28T00:00:00.000Z'),
    });
    const submit = (id: string, text: string, urgent = false) =>
      runtime.submit({
        conversationId: 'priority-runtime',
        idempotencyKey: id,
        context: {},
        parts: [{ type: 'text', text }],
        metadata: { urgent },
        recordIds: recordIds(id),
      });

    const first = submit('A', 'INPUT_A');
    await firstStarted.promise;
    const ordinary = submit('B', 'INPUT_B');
    await ordinary.accepted;
    const urgent = submit('C', 'INPUT_C', true);
    await urgent.accepted;

    const [firstResult, urgentResult, ordinaryResult] = await Promise.all([
      first.result,
      urgent.result,
      ordinary.result,
    ]);
    expect(firstResult.reason).toBe('interrupted');
    expect(urgentResult.reason).toBe('success');
    expect(ordinaryResult.reason).toBe('success');
    expect(urgentResult.run.id).toBe('C');
    expect(ordinaryResult.run.id).toBe('B');
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain('INPUT_C');
    expect(prompts[1]).not.toContain('INPUT_B');
    expect(prompts[2]).toContain('INPUT_C');
    expect(prompts[2]).toContain('ANSWER_C');
    expect(prompts[2]).toContain('INPUT_B');

    const snapshot = await store.loadSnapshot('priority-runtime');
    expect(snapshot.runs.map((run) => run.id)).toEqual(['A', 'C', 'B']);
    const [firstSequence, urgentSequence, ordinarySequence] = snapshot.runs.map(
      (run) => run.executionSequence,
    );
    if (
      firstSequence === undefined ||
      urgentSequence === undefined ||
      ordinarySequence === undefined
    ) {
      throw new Error('every executed run must retain its execution sequence');
    }
    expect(firstSequence).toBeLessThan(urgentSequence);
    expect(urgentSequence).toBeLessThan(ordinarySequence);
    expect(snapshot.messages.map((message) => message.id)).toEqual([
      'A-input',
      'A-assistant',
      'C-input',
      'C-assistant',
      'B-input',
      'B-assistant',
    ]);
    await runtime.close();
  });

  test('recovery preserves urgent order across equal timestamps and scan pages', async () => {
    const store = createMemoryAgentRuntimeStore();
    const conversationId = 'priority-recovery';
    for (const [id, priority] of [
      ['B', undefined],
      ['C', 'interrupt-next'],
    ] satisfies ReadonlyArray<readonly [string, 'interrupt-next' | undefined]>) {
      const createdAt = '2026-08-28T00:00:00.000Z';
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
          ...(priority && { queuePriority: priority }),
          createdAt,
          updatedAt: createdAt,
        }),
      });
    }
    const order: string[] = [];
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        const rendered = JSON.stringify(prompt);
        const id = rendered.includes('INPUT_C') && !rendered.includes('INPUT_B') ? 'C' : 'B';
        order.push(id);
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: `text-${id}` },
              { type: 'text-delta', id: `text-${id}`, delta: `ANSWER_${id}` },
              { type: 'text-end', id: `text-${id}` },
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

    const outcomes = await runtime.recover({ resolveContext: () => ({}), pageSize: 1 });
    expect(outcomes.map((outcome) => outcome.runId)).toEqual(['C', 'B']);
    await Promise.all(
      outcomes.map((outcome) => {
        if (!outcome.result) throw new Error('recovered run has no observable result');
        return outcome.result;
      }),
    );
    expect(order).toEqual(['C', 'B']);
    expect((await store.loadSnapshot(conversationId)).runs.map((run) => run.id)).toEqual([
      'C',
      'B',
    ]);
    await runtime.close();
  });

  test('execution sequence is assigned by the winning acquisition, not admission', async () => {
    const store = createMemoryAgentRuntimeStore();
    const input = AgentMessageSchema.parse({
      schemaVersion: 1,
      id: 'forged-input',
      conversationId: 'forged-order',
      role: 'user',
      status: 'committed',
      parts: [{ type: 'text', text: 'forged' }],
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
    });
    const run = AgentRunSchema.parse({
      schemaVersion: 1,
      id: 'forged-run',
      conversationId: input.conversationId,
      inputMessageIds: [input.id],
      assistantMessageId: 'forged-assistant',
      state: 'queued',
      revision: 0,
      executionSequence: 999,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    });

    await expect(
      store.acceptInputAndAssignRun({ idempotencyKey: 'forged', input, run }),
    ).rejects.toThrow('one valid assignment');
  });
});
