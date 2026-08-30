import { describe, expect, test } from 'bun:test';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  HeadlessAgentRunnerControlSchema,
  runHeadlessAgentRunner,
} from '../examples/headless-agent-runner';
import { createMemoryAgentRuntimeStore, defineAgentProtocol } from '../src/agent-runtime';
import { createHeadlessAgentHarness } from '../src/agent-runtime-harness';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 0, text: 0, reasoning: undefined },
};

describe('structured headless Agent runner example', () => {
  test('admits, interrupts, snapshots and closes through typed controls', async () => {
    const started = Promise.withResolvers<void>();
    const model = new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => {
        started.resolve();
        if (!abortSignal?.aborted) {
          await new Promise<void>((resolve) =>
            abortSignal?.addEventListener('abort', () => resolve(), { once: true }),
          );
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: undefined },
                usage,
              },
            ],
          }),
        };
      },
    });
    const harness = createHeadlessAgentHarness({
      protocol: defineAgentProtocol({
        context: z.object({}),
        inputMetadata: z.object({}),
      }),
      store: createMemoryAgentRuntimeStore(),
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'fixture',
            modelId: 'runner',
            contextWindow: 8_000,
            capabilities: [],
          },
          model,
        }),
      },
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
    const admitted = Promise.withResolvers<string>();
    const output: unknown[] = [];
    async function* controls() {
      yield HeadlessAgentRunnerControlSchema.parse({
        type: 'submit',
        requestId: 'submit-1',
        conversationId: 'conversation',
        idempotencyKey: 'input-1',
        context: {},
        parts: [{ type: 'text', text: 'run' }],
        metadata: {},
      });
      const runId = await admitted.promise;
      await started.promise;
      yield HeadlessAgentRunnerControlSchema.parse({
        type: 'interrupt',
        requestId: 'interrupt-1',
        conversationId: 'conversation',
        runId,
      });
      yield HeadlessAgentRunnerControlSchema.parse({
        type: 'snapshot',
        requestId: 'snapshot-1',
        conversationId: 'conversation',
      });
      yield HeadlessAgentRunnerControlSchema.parse({
        type: 'close',
        requestId: 'close-1',
      });
    }

    await runHeadlessAgentRunner({
      harness,
      input: controls(),
      write: (value) => {
        output.push(value);
        const parsed = z
          .object({
            type: z.string(),
            admission: z.object({ runId: z.string() }).optional(),
          })
          .loose()
          .parse(value);
        if (parsed.type === 'admitted' && parsed.admission) {
          admitted.resolve(parsed.admission.runId);
        }
      },
    });

    expect(output).toContainEqual(
      expect.objectContaining({ type: 'interrupted', requestId: 'interrupt-1' }),
    );
    expect(output).toContainEqual(
      expect.objectContaining({ type: 'snapshot', requestId: 'snapshot-1' }),
    );
    expect(output).toContainEqual(
      expect.objectContaining({ type: 'closed', requestId: 'close-1' }),
    );
    expect(output).toContainEqual(
      expect.objectContaining({
        type: 'terminal',
        requestId: 'submit-1',
        result: expect.objectContaining({ reason: 'interrupted' }),
      }),
    );
  });
});
