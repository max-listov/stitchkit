import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  type AgentRuntimeStore,
  createAgentRuntime,
  defineAgentProtocol,
} from '../../src/entrypoints/agent-runtime';

export function branchRuntime(
  store: AgentRuntimeStore,
  onPrompt: (prompt: unknown) => void = () => undefined,
) {
  return createAgentRuntime({
    protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
    store,
    models: {
      resolve: () => ({
        descriptor: {
          provider: 'test',
          modelId: 'branch-fixture',
          contextWindow: 4096,
          capabilities: [],
        },
        model: new MockLanguageModelV4({
          doStream: async (options) => {
            onPrompt(options.prompt);
            return {
              stream: simulateReadableStream({
                chunks: [
                  { type: 'text-start', id: 'text' },
                  { type: 'text-delta', id: 'text', delta: 'retained answer' },
                  { type: 'text-end', id: 'text' },
                  {
                    type: 'finish',
                    finishReason: { unified: 'stop', raw: undefined },
                    usage: {
                      inputTokens: {
                        total: 1,
                        noCache: 1,
                        cacheRead: undefined,
                        cacheWrite: undefined,
                      },
                      outputTokens: { total: 1, text: 1, reasoning: undefined },
                    },
                  },
                ],
              }),
            };
          },
        }),
      }),
    },
    prompt: () => ({
      instructions: 'test',
      sections: [],
      instructionTokens: { provenance: 'unavailable' },
      contextDecision: 'unavailable',
    }),
    tools: () => ({}),
  });
}
