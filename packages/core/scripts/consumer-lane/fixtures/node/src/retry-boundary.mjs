/** A cut stream is retried once, at a durable boundary, and the partial output is dropped. */
import {
  AgentProviderStreamCutError,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from 'stitchkit/agent-runtime';
import { createScriptedModelDriver } from 'stitchkit/agent-runtime/testing';
import { z } from 'zod';
import { proof } from './packed-sqlite.mjs';

const usage = {
  inputTokens: { value: 1, provenance: 'provider-reported' },
  outputTokens: { value: 1, provenance: 'provider-reported' },
};
const driver = createScriptedModelDriver({
  provider: 'fault',
  modelId: 'fault',
  steps: [
    [
      { type: 'text-start', id: 'a' },
      { type: 'text-delta', id: 'a', delta: 'partial' },
      { type: 'error', error: new AgentProviderStreamCutError() },
    ],
    [
      { type: 'text-start', id: 'b' },
      { type: 'text-delta', id: 'b', delta: 'recovered' },
      { type: 'text-end', id: 'b' },
      { type: 'finish', finishReason: 'stop', usage },
    ],
  ],
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
      driver,
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
    driver.requests.length === 2 &&
      result.reason === 'success' &&
      parts.includes('recovered') &&
      !parts.includes('partial') &&
      kinds.indexOf('retry/scheduled') >= 0 &&
      kinds.indexOf('retry/scheduled') < kinds.indexOf('retry/started'),
    `calls ${driver.requests.length}, reason ${result.reason}, kinds ${kinds.join(',')}`,
  );
} finally {
  await runtime.close();
}
