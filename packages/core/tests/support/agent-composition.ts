import { z } from 'zod';
import {
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../../src/entrypoints/agent-runtime';
import {
  createHeadlessAgentHarness,
  type HeadlessAgentHarnessConfig,
} from '../../src/entrypoints/agent-runtime/harness';
import type { AgentToolSet } from '../../src/entrypoints/tools';
import { until } from './until';

export function compositionHarness(
  overrides: Partial<HeadlessAgentHarnessConfig<{ owner: string }, AgentToolSet>> = {},
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
        driver: {
          provider: 'fixture',
          modelId: 'composition',
          async stream() {
            return {
              parts: {
                async *[Symbol.asyncIterator]() {
                  yield { type: 'text-start', id: 'answer' };
                  yield { type: 'text-delta', id: 'answer', delta: `Hello ${context.owner}` };
                  yield { type: 'text-end', id: 'answer' };
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
