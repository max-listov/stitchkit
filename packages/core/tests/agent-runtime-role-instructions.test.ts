import { describe, expect, test } from 'bun:test';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  composeAgentPrompt,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../src/agent-runtime';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

describe('role-aware instructions', () => {
  test('system sections form instructions, user sections form user history', async () => {
    const prompt = composeAgentPrompt<Record<string, never>>([
      { name: 'policy', stability: 'stable', render: () => 'be terse' },
      { name: 'brief', stability: 'dynamic', role: 'user', render: () => 'tenant acme' },
      { name: 'blank', stability: 'dynamic', role: 'user', render: () => '   ' },
    ]);
    const composed = await prompt({
      context: {},
      signal: new AbortController().signal,
    });
    // The brief is not in the system prompt — that is the whole point.
    expect(composed.instructions).toBe('be terse');
    expect(composed.userInstructions).toEqual([{ name: 'brief', text: 'tenant acme' }]);
    expect(composed.sections.map(({ role }) => role)).toEqual(['system', 'user', 'user']);
    expect(composed.instructionTokens).toEqual({ provenance: 'unavailable' });
    expect(composed.userInstructionTokens).toEqual({ provenance: 'unavailable' });
  });

  test('a user-role section reaches the provider as user history, ahead of the conversation', async () => {
    const prompts: unknown[][] = [];
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        prompts.push(prompt as unknown[]);
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: 'answer' },
              { type: 'text-delta', id: 'answer', delta: 'ok' },
              { type: 'text-end', id: 'answer' },
              { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
            ],
          }) as never,
        };
      },
    });
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store: createMemoryAgentRuntimeStore(),
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'test',
            modelId: 'role-instructions',
            contextWindow: 100_000,
            capabilities: [],
          },
          model,
        }),
      },
      prompt: () => ({
        instructions: 'SYSTEM ONLY',
        sections: [],
        userInstructions: [{ name: 'brief', text: 'TENANT BRIEF' }],
        instructionTokens: { provenance: 'unavailable' },
        userInstructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({}),
      loop: { maxSteps: 2 },
    });
    await runtime.submit({
      conversationId: 'c1',
      idempotencyKey: 'i1',
      context: {},
      parts: [{ type: 'text', text: 'hello there' }],
      metadata: {},
    }).result;

    const messages = prompts[0] as { role?: string }[];
    const briefAt = messages.findIndex((message) =>
      JSON.stringify(message).includes('TENANT BRIEF'),
    );
    const helloAt = messages.findIndex((message) =>
      JSON.stringify(message).includes('hello there'),
    );
    expect(briefAt).toBeGreaterThanOrEqual(0);
    expect(messages[briefAt]?.role).toBe('user');
    expect(briefAt).toBeLessThan(helloAt);
  });
});
