import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  type CompletionInvocationInput,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  createModelInvocationLedger,
  defineAgentProtocol,
  defineModelRegistry,
  type ModelInvocationConfig,
} from '../src/entrypoints/agent-runtime';

const descriptor = {
  provider: 'mock',
  modelId: 'model',
  contextWindow: 8_000,
  capabilities: [],
};
const trace = { operationId: 'operation', project: 'project', purpose: 'purpose' };
const input: CompletionInvocationInput = {
  conversationId: 'conv',
  idempotencyKey: 'once',
  trace,
  models: ['model'],
  prompt: 'private-prompt',
  timeoutMs: 20,
};
const usage = {
  inputTokens: { total: 8, noCache: 8, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};
function setup(
  model = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'ok' }],
      usage,
      warnings: [],
      finishReason: { unified: 'stop', raw: undefined },
    }),
  }),
  extra: Partial<ModelInvocationConfig> = {},
) {
  const store = createMemoryAgentRuntimeStore();
  const models = defineModelRegistry({
    models: { model: descriptor },
    providers: { mock: { create: () => model } },
  });
  const ledger = createModelInvocationLedger({
    store,
    models,
    payloadKey: randomBytes(32),
    authorize: () => ({ subject: 'verified' }),
    ...extra,
  });
  return { store, ledger, model, models };
}

test('receipt admission and transport audit failures never invoke or retry the provider', async () => {
  const store = createMemoryAgentRuntimeStore();
  const refused = setup(undefined, {
    store: {
      ...store,
      appendEventOnce: async () => {
        throw new Error('admission unavailable');
      },
    },
  });
  await expect(refused.ledger.complete(input, {})).rejects.toThrow('admission unavailable');
  expect(refused.model.doGenerateCalls).toHaveLength(0);
  const audit = setup(undefined, {
    onAttempt: () => {
      throw new Error('audit unavailable');
    },
  });
  expect(
    (await audit.ledger.complete({ ...input, models: ['model', 'model'] }, {})).outcome,
  ).toBe('failed');
  expect(audit.model.doGenerateCalls).toHaveLength(0);
  const records = (await audit.ledger.read({ conversationId: 'conv', limit: 100 }, {})).items;
  expect(records.filter(({ record }) => record.type === 'provider/request')).toHaveLength(1);
  expect(records.filter(({ record }) => record.type === 'provider/response')).toHaveLength(1);
});

test('timeout and pre-abort end truthfully and do not try a fallback', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: ({ abortSignal }) =>
      new Promise((_resolve, reject) => {
        if (!abortSignal) throw new Error('Missing deadline');
        if (abortSignal.aborted) reject(abortSignal.reason);
        else
          abortSignal.addEventListener('abort', () => reject(abortSignal.reason), {
            once: true,
          });
      }),
  });
  const { ledger } = setup(model);
  expect((await ledger.complete({ ...input, models: ['model', 'model'] }, {})).outcome).toBe(
    'cancelled',
  );
  expect(model.doGenerateCalls).toHaveLength(1);
  const records = (await ledger.read({ conversationId: 'conv', limit: 100 }, {})).items;
  expect(
    records.some(
      ({ record }) => record.type === 'provider/response' && record.status === 'cancelled',
    ),
  ).toBe(true);
  expect(
    (await ledger.complete({ ...input, idempotencyKey: 'aborted' }, {}, AbortSignal.abort()))
      .outcome,
  ).toBe('cancelled');
  expect(model.doGenerateCalls).toHaveLength(1);
});

test('payload limits, missing atomic admission and wrong stores fail closed', async () => {
  const limited = setup(undefined, { maxPayloadBytes: 1_024 });
  expect(
    (await limited.ledger.complete({ ...input, prompt: 'x'.repeat(10_000) }, {})).outcome,
  ).toBe('failed');
  expect(limited.model.doGenerateCalls).toHaveLength(0);
  const { appendEventOnce: _once, ...unsupported } = createMemoryAgentRuntimeStore();
  expect(() => setup(undefined, { store: unsupported })).toThrow('atomic');
  expect(() => setup(undefined, { payloadKey: new Uint8Array(31) })).toThrow('32 bytes');
  const { ledger, models } = setup();
  const model = models.resolve('model');
  const runtime = createAgentRuntime({
    store: createMemoryAgentRuntimeStore(),
    protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
    models: { resolve: () => model },
    tools: () => ({}),
    prompt: () => ({
      instructions: '',
      sections: [],
      instructionTokens: { provenance: 'unavailable' },
      contextDecision: 'unavailable',
    }),
    invocations: { ledger, trace: () => trace },
  });
  try {
    const result = await runtime.submit({
      conversationId: 'conv',
      idempotencyKey: 'agent',
      context: {},
      parts: [{ type: 'text', text: 'hi' }],
    }).result;
    expect(result.reason).toBe('runtime_failure');
  } finally {
    await runtime.close();
  }
});

test('agent failure keeps the billed finish and records exactly one response per attempt', async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'error', error: new Error('private failure') },
          { type: 'finish', finishReason: { unified: 'error', raw: undefined }, usage },
        ],
      }),
    }),
  });
  const { ledger, store, models } = setup(model);
  const runtime = createAgentRuntime({
    store,
    protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
    models: { resolve: () => models.resolve('model') },
    tools: () => ({}),
    prompt: () => ({
      instructions: '',
      sections: [],
      instructionTokens: { provenance: 'unavailable' },
      contextDecision: 'unavailable',
    }),
    invocations: { ledger, trace: () => trace },
  });
  try {
    const result = await runtime.submit({
      conversationId: 'conv',
      idempotencyKey: 'agent',
      context: {},
      parts: [{ type: 'text', text: 'hi' }],
    }).result;
    expect(result.reason).toBe('provider_failure');
    const responses = (
      await ledger.read({ conversationId: 'conv', limit: 100 }, {})
    ).items.flatMap(({ record }) => (record.type === 'provider/response' ? [record] : []));
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      status: 'failed',
      usage: { inputTokens: { value: 8, provenance: 'provider-reported' } },
    });
  } finally {
    await runtime.close();
  }
});

test('error finishes fall back and non-provider failures expose only an encrypted cause reference', async () => {
  let calls = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      calls += 1;
      return {
        content: [{ type: 'text', text: 'output' }],
        usage,
        warnings: [],
        finishReason: { unified: calls === 1 ? 'error' : 'stop', raw: undefined },
      };
    },
  });
  const fallback = setup(model);
  expect(
    (await fallback.ledger.complete({ ...input, models: ['model', 'model'] }, {})).outcome,
  ).toBe('succeeded');
  expect(calls).toBe(2);
  const failure = setup(undefined, {
    onAttempt: () => {
      throw new Error('private audit detail');
    },
  });
  expect((await failure.ledger.complete(input, {})).outcome).toBe('failed');
  const page = await failure.ledger.read({ conversationId: 'conv', limit: 100 }, {});
  const terminal = page.items.find(
    ({ record }) => record.type === 'invocation/finished',
  )?.record;
  if (terminal?.type !== 'invocation/finished' || !terminal.failure)
    throw new Error('Missing cause reference');
  expect(JSON.stringify(page)).not.toContain('private audit detail');
  const cause = await failure.ledger.readPayload(
    { conversationId: 'conv', artifactId: terminal.failure.artifactId },
    {},
  );
  expect(JSON.stringify(cause)).toContain('private audit detail');
});
