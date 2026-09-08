/** A cut stream is retried once, at a durable boundary, and the partial output is dropped. */
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import {
  AgentProviderStreamCutError,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from 'stitchkit/agent-runtime';
import { z } from 'zod';
import { proof } from './packed-sqlite.mjs';

let calls = 0;
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const model = new MockLanguageModelV4({
  doStream: async () => {
    calls += 1;
    const chunks =
      calls === 1
        ? [
            { type: 'text-start', id: 'a' },
            { type: 'text-delta', id: 'a', delta: 'partial' },
            { type: 'error', error: new AgentProviderStreamCutError() },
          ]
        : [
            { type: 'text-start', id: 'b' },
            { type: 'text-delta', id: 'b', delta: 'recovered' },
            { type: 'text-end', id: 'b' },
            { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
          ];
    return { stream: simulateReadableStream({ chunks }) };
  },
});
const store = createMemoryAgentRuntimeStore();
const runtime = createAgentRuntime({
  protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
  store,
  models: {
    resolve: () => ({
      descriptor: {
        provider: 'fault',
        modelId: 'fault',
        contextWindow: 8_000,
        capabilities: [],
      },
      model,
    }),
  },
  prompt: () => ({
    instructions: 'retry',
    sections: [],
    instructionTokens: { provenance: 'unavailable' },
    contextDecision: 'unavailable',
  }),
  tools: () => ({}),
  loop: { retry: { maxAttempts: 2, delayMs: () => 0 } },
});
try {
  const result = await runtime.submit({
    conversationId: 'r',
    idempotencyKey: 'r-1',
    context: {},
    parts: [{ type: 'text', text: 'go' }],
  }).result;
  const parts = JSON.stringify(result.message.parts);
  const kinds = (await store.readEvents({ conversationId: 'r', limit: 100 })).items.map(
    (e) => e.kind,
  );
  proof(
    'retry boundary',
    calls === 2 &&
      result.reason === 'success' &&
      parts.includes('recovered') &&
      !parts.includes('partial') &&
      kinds.indexOf('retry/scheduled') >= 0 &&
      kinds.indexOf('retry/scheduled') < kinds.indexOf('retry/started'),
    `calls ${calls}, reason ${result.reason}, kinds ${kinds.join(',')}`,
  );
} finally {
  await runtime.close();
}
