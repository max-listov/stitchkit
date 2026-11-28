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
        driver: {
          provider: 'test',
          modelId: 'branch-fixture',
          async stream(request) {
            onPrompt([...request.instructions, ...request.messages]);
            return {
              parts: {
                async *[Symbol.asyncIterator]() {
                  yield { type: 'text-start', id: 'text' };
                  yield { type: 'text-delta', id: 'text', delta: 'retained answer' };
                  yield { type: 'text-end', id: 'text' };
                  yield {
                    type: 'finish',
                    finishReason: 'stop',
                    usage: {
                      inputTokens: { value: 1, provenance: 'provider-reported' },
                      outputTokens: { value: 1, provenance: 'provider-reported' },
                    },
                  };
                },
              },
            };
          },
        },
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
