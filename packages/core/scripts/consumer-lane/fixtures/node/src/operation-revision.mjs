/**
 * A run whose store is genuinely asynchronous, taken from the packed tarball.
 *
 * The assistant checkpoint and the model-request admission are two owned
 * mutations of one run, written by two independent schedules: the stream
 * consumer and the model driver lifecycle. When the store answers on a later
 * tick, both used to name the revision they read before their own `await`, and
 * the loser of that race threw a store conflict — so the provider was never
 * called and the run ended `provider_failure`.
 *
 * A consumer reported it against a published release that every in-repo gate
 * had passed, so the proof belongs here, on the artifact as it is installed.
 */
import { setImmediate } from 'node:timers/promises';
import {
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from 'stitchkit/agent-runtime';
import { createScriptedModelDriver } from 'stitchkit/agent-runtime/testing';
import { z } from 'zod';

const durable = createMemoryAgentRuntimeStore();
const outcomes = [];
const driver = createScriptedModelDriver({
  provider: 'fixture',
  modelId: 'fixture',
  steps: [
    [
      { type: 'text-start', id: 'answer' },
      { type: 'text-delta', id: 'answer', delta: 'done' },
      { type: 'text-end', id: 'answer' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: {
          inputTokens: { value: 1, provenance: 'provider-reported' },
          outputTokens: { value: 1, provenance: 'provider-reported' },
        },
      },
    ],
  ],
});

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
      driver,
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
  if (
    result.reason !== 'success' ||
    driver.requests.length !== 1 ||
    text !== 'done' ||
    conflicts.length > 0
  ) {
    console.error(
      `[operation-revision] reason=${result.reason} calls=${driver.requests.length} text=${text} conflicts=${conflicts.join(',') || 'none'}`,
    );
    process.exitCode = 1;
  } else {
    console.log('packed operation revision: ok');
  }
} finally {
  await runtime.close();
}
