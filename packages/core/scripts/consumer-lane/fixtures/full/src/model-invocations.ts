import { MockLanguageModelV4 } from 'ai/test';
import {
  createMemoryAgentRuntimeStore,
  createModelInvocationLedger,
  currentModelInvocationAttempt,
  defineModelRegistry,
} from 'stitchkit/agent-runtime';

let calls = 0;
let attemptId: string | undefined;
const model = new MockLanguageModelV4({
  doGenerate: async ({ prompt, tools }) => {
    calls += 1;
    attemptId = currentModelInvocationAttempt()?.attemptId;
    if (prompt.length !== 1 || prompt[0]?.role !== 'user' || tools?.length) {
      throw new Error('Completion acquired agent instructions or tools');
    }
    return {
      content: [{ type: 'text', text: 'receipt delivered' }],
      usage: {
        inputTokens: {
          total: undefined,
          noCache: undefined,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: undefined, text: undefined, reasoning: undefined },
      },
      finishReason: { unified: 'stop', raw: undefined },
      warnings: [],
    };
  },
});
const models = defineModelRegistry({
  models: {
    primary: { provider: 'test', modelId: 'requested', contextWindow: 4096, capabilities: [] },
  },
  providers: { test: { create: () => model } },
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
