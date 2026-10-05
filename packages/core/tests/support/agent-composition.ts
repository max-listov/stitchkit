import { simulateReadableStream, type ToolSet } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../../src/entrypoints/agent-runtime';
import {
  createHeadlessAgentHarness,
  type HeadlessAgentHarnessConfig,
} from '../../src/entrypoints/agent-runtime/harness';
import { until } from './until';

export function compositionHarness(
  overrides: Partial<HeadlessAgentHarnessConfig<{ owner: string }, ToolSet>> = {},
) {
  return createHeadlessAgentHarness({
    protocol: defineAgentProtocol({
      context: z.object({ owner: z.string() }),
      inputMetadata: z.object({}),
      terminalAcceptance: 'require-output',
    }),
    store: createMemoryAgentRuntimeStore(),
    models: {
      resolve: ({ context }) => ({
        descriptor: {
          provider: 'fixture',
          modelId: 'composition',
          contextWindow: 8_000,
          capabilities: [],
        },
        model: new MockLanguageModelV4({
          doStream: async () => ({
            stream: simulateReadableStream({
              chunks: [
                { type: 'text-start', id: 'answer' },
                { type: 'text-delta', id: 'answer', delta: `Hello ${context.owner}` },
                { type: 'text-end', id: 'answer' },
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
          }),
        }),
      }),
    },
    resources: { load: async () => ({ resources: [], diagnostics: [] }) },
    promptBudget: ({ contextWindow }) => ({
      contextWindow,
      reservedOutput: 1_000,
      toolSchemas: { value: 0, provenance: 'measured' },
      attachments: { value: 0, provenance: 'measured' },
      providerOverhead: { provenance: 'unavailable' },
    }),
    tools: () => ({}),
    ...overrides,
  });
}

export function eventually(predicate: () => boolean, timeoutMs = 3_000) {
  return until(predicate, 'the composition condition to settle', timeoutMs);
}
