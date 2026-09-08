/**
 * A run whose store is genuinely asynchronous, taken from the packed tarball.
 *
 * The assistant checkpoint and the model-request admission are two owned
 * mutations of one run, written by two independent schedules: the stream
 * consumer and the SDK's model middleware. When the store answers on a later
 * tick, both used to name the revision they read before their own `await`, and
 * the loser of that race threw a store conflict from inside `wrapStream` — so
 * the provider was never called and the run ended `provider_failure`.
 *
 * A consumer reported it against a published release that every in-repo gate
 * had passed, so the proof belongs here, on the artifact as it is installed.
 */
import { setImmediate } from 'node:timers/promises';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import {
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from 'stitchkit/agent-runtime';
import { z } from 'zod';

const durable = createMemoryAgentRuntimeStore();
const outcomes = [];
let calls = 0;

const runtime = createAgentRuntime({
  protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
  store: {
    ...durable,
    async checkpointRunAssistant(input) {
      await setImmediate();
      const result = await durable.checkpointRunAssistant(input);
      outcomes.push(`checkpoint:${result.outcome}`);
      return result;
    },
    async recordRunOperation(input) {
      await setImmediate();
      const result = await durable.recordRunOperation(input);
      outcomes.push(`operation:${result.outcome}`);
      return result;
    },
  },
  loop: { checkpointEveryEvents: 1 },
  models: {
    resolve: () => ({
      descriptor: {
        provider: 'fixture',
        modelId: 'fixture',
        contextWindow: 32768,
        capabilities: [],
      },
      model: new MockLanguageModelV3({
        doStream: async () => {
          calls += 1;
          return {
            stream: convertArrayToReadableStream([
              { type: 'text-start', id: 'answer' },
              { type: 'text-delta', id: 'answer', delta: 'done' },
              { type: 'text-end', id: 'answer' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: undefined },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 1, reasoning: 0 },
                },
              },
            ]),
          };
        },
      }),
    }),
  },
  prompt: () => ({
    instructions: 'Fixture',
    sections: [],
    instructionTokens: { provenance: 'unavailable' },
    contextDecision: 'unavailable',
  }),
  tools: () => ({}),
});

try {
  const result = await runtime.submit({
    conversationId: 'fixture',
    idempotencyKey: 'input',
    context: {},
    metadata: {},
    parts: [{ type: 'text', text: 'Fixture' }],
  }).result;

  const conflicts = outcomes.filter((outcome) => !outcome.endsWith(':applied'));
  const text = result.message.parts.map((part) => part.text ?? '').join('');
  if (result.reason !== 'success' || calls !== 1 || text !== 'done' || conflicts.length > 0) {
    console.error(
      `[operation-revision] reason=${result.reason} calls=${calls} text=${text} conflicts=${conflicts.join(',') || 'none'}`,
    );
    process.exitCode = 1;
  } else {
    console.log('packed operation revision: ok');
  }
} finally {
  await runtime.close();
}
