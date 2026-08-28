import { describe, expect, test } from 'bun:test';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { createHeadlessAgentHarness } from '../examples/headless-agent-harness';
import { createMemoryAgentRuntimeStore, defineAgentProtocol } from '../src/agent-runtime';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

describe('executable headless agent harness example', () => {
  test('isolates scoped resources and reports their diagnostics', async () => {
    const diagnostics: string[] = [];
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: 'answer' },
            { type: 'text-delta', id: 'answer', delta: 'done' },
            { type: 'text-end', id: 'answer' },
            { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
          ],
        }),
      }),
    });
    const runtime = createHeadlessAgentHarness({
      protocol: defineAgentProtocol({
        context: z.object({ resource: z.string() }),
        inputMetadata: z.object({}),
        terminalAcceptance: 'require-output',
      }),
      store: createMemoryAgentRuntimeStore(),
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'test',
            modelId: 'headless',
            contextWindow: 8_000,
            capabilities: [],
          },
          model,
        }),
      },
      resources: {
        load: ({ context }) => ({
          resources: [
            { name: 'instructions', text: context.resource, provenance: 'fixture:injected' },
          ],
          diagnostics: [
            { resource: 'instructions', severity: 'warning', message: context.resource },
          ],
        }),
        onDiagnostics: ({ diagnostics: received }) => {
          diagnostics.push(...received.map(({ message }) => message));
        },
      },
      promptBudget: ({ contextWindow }) => ({
        contextWindow,
        reservedOutput: 1_000,
        toolSchemas: { value: 0, provenance: 'measured' },
        attachments: { value: 0, provenance: 'measured' },
        providerOverhead: { provenance: 'unavailable' },
      }),
      estimateResourceTokens: () => ({ value: 1, provenance: 'measured' }),
      tools: () => ({}),
    });

    const submit = (conversationId: string, resource: string) =>
      runtime.submit({
        conversationId,
        idempotencyKey: `request-${conversationId}`,
        context: { resource },
        parts: [{ type: 'text', text: 'run' }],
        metadata: {},
      }).result;
    const [first, second] = await Promise.all([
      submit('session-a', 'RESOURCE_A'),
      submit('session-b', 'RESOURCE_B'),
    ]);

    expect(first.reason).toBe('success');
    expect(second.reason).toBe('success');
    const prompts = model.doStreamCalls.map((call) => JSON.stringify(call.prompt));
    expect(prompts).toHaveLength(2);
    expect(prompts.some((value) => value.includes('RESOURCE_A'))).toBe(true);
    expect(prompts.some((value) => value.includes('RESOURCE_B'))).toBe(true);
    expect(
      prompts.every(
        (value) => !(value.includes('RESOURCE_A') && value.includes('RESOURCE_B')),
      ),
    ).toBe(true);
    expect(diagnostics.sort()).toEqual(['RESOURCE_A', 'RESOURCE_B']);
    await runtime.close();
  });
});
