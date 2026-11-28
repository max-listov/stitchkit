import {
  createMemoryAgentRuntimeStore,
  createModelInvocationLedger,
  currentModelInvocationAttempt,
  defineModelRegistry,
} from 'stitchkit/agent-runtime';
import { createScriptedModelDriver } from 'stitchkit/agent-runtime/testing';

let calls = 0;
let attemptId: string | undefined;
const driver = createScriptedModelDriver({
  provider: 'test',
  modelId: 'requested',
  steps: [
    async (request) => {
      calls += 1;
      attemptId = currentModelInvocationAttempt()?.attemptId;
      if (
        request.instructions.length !== 0 ||
        request.messages.length !== 1 ||
        request.messages[0]?.role !== 'user' ||
        request.tools.length !== 0
      ) {
        throw new Error('Completion acquired agent instructions or tools');
      }
      return {
        parts: (async function* () {
          yield { type: 'text-start' as const, id: 'completion' };
          yield { type: 'text-delta' as const, id: 'completion', delta: 'receipt delivered' };
          yield { type: 'text-end' as const, id: 'completion' };
          yield {
            type: 'finish' as const,
            finishReason: 'stop' as const,
            usage: {
              inputTokens: { provenance: 'unavailable' as const },
              outputTokens: { provenance: 'unavailable' as const },
            },
          };
        })(),
      };
    },
  ],
});
const models = defineModelRegistry({
  models: {
    primary: { provider: 'test', modelId: 'requested', contextWindow: 4096, capabilities: [] },
  },
  providers: { test: { create: () => driver } },
});
const ledger = createModelInvocationLedger({
  store: createMemoryAgentRuntimeStore(),
  models,
  payloadKey: crypto.getRandomValues(new Uint8Array(32)),
  authorize: ({ context }) => {
    if (context !== 'authenticated') throw new Error('Forbidden');
    return { subject: 'consumer' };
  },
});
const input = {
  conversationId: 'consumer',
  idempotencyKey: 'completion',
  prompt: 'exact prompt',
  models: ['primary'],
  timeoutMs: 1000,
  trace: { operationId: 'operation', project: 'consumer', purpose: 'verification' },
};
const result = await ledger.complete(input, 'authenticated');
if (result.outcome !== 'succeeded' || result.text !== 'receipt delivered' || !attemptId) {
  throw new Error('Published completion or transport context failed');
}
if ((await ledger.complete(input, 'authenticated')).outcome !== 'duplicate' || calls !== 1) {
  throw new Error('Published completion executed twice');
}
const page = await ledger.read({ conversationId: 'consumer', limit: 100 }, 'authenticated');
const response = page.items.find(({ record }) => record.type === 'provider/response')?.record;
if (
  response?.type !== 'provider/response' ||
  response.attemptId !== attemptId ||
  response.usage.inputTokens.provenance !== 'unavailable' ||
  response.effective.modelId !== null
) {
  throw new Error('Published receipt invented missing evidence');
}
console.log('model invocation consumer: ok');
