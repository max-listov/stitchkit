import { describe, expect, test } from 'bun:test';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  AgentProviderStreamCutError,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../src/agent-runtime';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function textIn(prompt: unknown): string {
  return JSON.stringify(prompt);
}

describe('an injected input survives a retried attempt', () => {
  /**
   * `take` removes an injection from the registry. A retry that restarted the
   * stream from the original history therefore ran without it — and the
   * terminal still absorbed it, recording a person's input as answered by a
   * model that never saw it.
   */
  test('the second attempt takes the injection again, and absorbs only what it saw', async () => {
    const store = createMemoryAgentRuntimeStore();
    const prompts: unknown[] = [];
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        calls += 1;
        prompts.push(prompt);
        const chunks: Record<string, unknown>[] =
          calls === 1
            ? [
                { type: 'text-start', id: 'a' },
                { type: 'text-delta', id: 'a', delta: 'partial' },
                { type: 'error', error: new AgentProviderStreamCutError() },
              ]
            : [
                { type: 'text-start', id: 'b' },
                { type: 'text-delta', id: 'b', delta: 'answered' },
                { type: 'text-end', id: 'b' },
                { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
              ];
        return { stream: simulateReadableStream({ chunks } as never) };
      },
    });
    // The first run is parked inside prompt composition, which is before the
    // provider is reached: the second input arrives while it waits, so step
    // zero's boundary is the one that takes the injection.
    const composing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let composed = 0;
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store,
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'test',
            modelId: 'test',
            contextWindow: 100_000,
            capabilities: [],
          },
          model,
        }),
      },
      prompt: async () => {
        composed += 1;
        if (composed === 1) {
          composing.resolve();
          await release.promise;
        }
        return {
          instructions: 'test',
          sections: [],
          instructionTokens: { provenance: 'unavailable' },
          contextDecision: 'unavailable',
        };
      },
      tools: () => ({}),
      loop: { retry: { maxAttempts: 2, delayMs: () => 0 } },
      runs: { inputPolicy: 'inject' },
    });
    const first = runtime.submit({
      conversationId: 'c',
      idempotencyKey: 'input-1',
      context: {},
      parts: [{ type: 'text', text: 'summarise this' }],
    });
    await first.accepted;
    await composing.promise;
    const second = runtime.submit({
      conversationId: 'c',
      idempotencyKey: 'input-2',
      context: {},
      parts: [{ type: 'text', text: 'in bullet points' }],
    });
    const secondAdmission = await second.admission;
    release.resolve();
    const firstResult = await first.result;
    await second.result;

    expect(calls).toBe(2);
    expect(firstResult.reason).toBe('success');
    // Both attempts saw the injected input; the answering one is what counts.
    expect(textIn(prompts[0])).toContain('in bullet points');
    expect(textIn(prompts[1])).toContain('in bullet points');
    const absorbed = await store.loadRun({
      conversationId: 'c',
      runId: secondAdmission.runId,
    });
    expect(absorbed?.run.terminalReason).toBe('absorbed');
    expect(absorbed?.run.absorbedIntoRunId).toBe(firstResult.run.id);
    await runtime.close();
  });
});
