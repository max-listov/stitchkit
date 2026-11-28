import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { invocationJson } from '../src/agent-runtime/invocation-payload';
import {
  agentSummaryProjection,
  type CompletionInvocationInput,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  createModelInvocationLedger,
  defineAgentProtocol,
  defineModelRegistry,
  type ModelInvocationConfig,
} from '../src/entrypoints/agent-runtime';
import { fromAiSdkModel } from '../src/entrypoints/agent-runtime/ai-sdk';

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
  prompt: 'prompt',
  timeoutMs: 1_000,
};
const usage = {
  inputTokens: { total: 8, noCache: 8, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};
const answering = (text = 'the answer') =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: text },
          { type: 'text-end', id: 't' },
          { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
        ],
      }),
    }),
  });

function setup(model: MockLanguageModelV4, extra: Partial<ModelInvocationConfig> = {}) {
  const store = createMemoryAgentRuntimeStore();
  const models = defineModelRegistry({
    models: { model: descriptor },
    providers: { mock: { create: () => fromAiSdkModel(model) } },
  });
  const ledger = createModelInvocationLedger({
    store,
    models,
    payloadKey: randomBytes(32),
    authorize: () => ({ subject: 'verified' }),
    ...extra,
  });
  return { store, ledger, models };
}

test('a long audited stream answers in full; its evidence is truncated and fingerprinted', async () => {
  const delta = 'x'.repeat(450);
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: 't' },
          ...Array.from({ length: 200 }, () => ({
            type: 'text-delta' as const,
            id: 't',
            delta,
          })),
          { type: 'text-end', id: 't' },
          { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
        ],
      }),
    }),
  });
  const { ledger, store, models } = setup(model, { maxPayloadBytes: 65_536 });
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
    expect(result.reason).toBe('success');
    const snapshot = JSON.stringify(await store.loadSnapshot('conv'));
    expect(snapshot).toContain(delta.repeat(200));
    const { items } = await ledger.read({ conversationId: 'conv', limit: 10_000 }, {});
    const response = items.find(({ record }) => record.type === 'provider/response')?.record;
    if (response?.type !== 'provider/response' || !response.artifactId)
      throw new Error('no provider response');
    expect(response.status).toBe('succeeded');
    const stored = await ledger.readPayload(
      { conversationId: 'conv', artifactId: response.artifactId },
      {},
    );
    if (stored.status !== 'available') throw new Error('expected available payload');
    const evidence = z
      .object({
        output: z.array(z.unknown()),
        truncated: z.object({ parts: z.number(), sha256: z.string().length(64) }),
      })
      .parse(stored.payload);
    expect(evidence.truncated.parts).toBe(202);
    expect(evidence.output.length).toBeLessThan(202);
  } finally {
    await runtime.close();
  }
});

test('an answer the provider gave survives a receipt that cannot be written', async () => {
  const { store, ledger, models } = setup(answering());
  const failing = {
    ...store,
    appendEvent: async (event: Parameters<typeof store.appendEvent>[0]) => {
      if (event.kind === 'invocation/finished') throw new Error('store unavailable');
      return store.appendEvent(event);
    },
  };
  const broken = createModelInvocationLedger({
    store: failing,
    models,
    payloadKey: randomBytes(32),
    authorize: () => ({ subject: 'verified' }),
  });
  const result = await broken.complete(input, {});
  expect(result).toMatchObject({ outcome: 'succeeded', text: 'the answer' });
  expect(String(result.receiptError)).toContain('store unavailable');
  expect((await ledger.complete({ ...input, idempotencyKey: 'plain' }, {})).receiptError).toBe(
    undefined,
  );
});

test('the summary projection names the model an audited request sent', () => {
  const state = agentSummaryProjection.fold(agentSummaryProjection.initial(), {
    conversationId: 'conv',
    seq: 1,
    eventId: 'e',
    schemaVersion: 1,
    kind: 'provider/request',
    occurredAt: new Date(0).toISOString(),
    payload: { requested: { modelId: 'asked' }, sent: { modelId: 'sent-model' } },
  });
  expect(state.lastModelId).toBe('sent-model');
});

test('an error whose cause chain loops serializes once per error', () => {
  const circular = new Error('loop');
  const inner = new Error('inner', { cause: circular });
  circular.cause = inner;
  expect(invocationJson({ error: circular })).toEqual({
    error: {
      name: 'Error',
      message: 'loop',
      cause: { name: 'Error', message: 'inner', cause: { name: 'Error', message: 'loop' } },
    },
  });
});

test("a provider attempt's own receipt failing costs neither the answer nor a long one", async () => {
  const { store, models } = setup(answering());
  const failing = {
    ...store,
    appendEvent: async (event: Parameters<typeof store.appendEvent>[0]) => {
      if (event.kind === 'provider/response') throw new Error('store unavailable');
      return store.appendEvent(event);
    },
  };
  const broken = createModelInvocationLedger({
    store: failing,
    models,
    payloadKey: randomBytes(32),
    authorize: () => ({ subject: 'verified' }),
  });
  const result = await broken.complete(input, {});
  expect(result).toMatchObject({ outcome: 'succeeded', text: 'the answer' });
  expect(result.receiptError).toMatchObject({
    name: 'InvocationReceiptError',
    cause: expect.objectContaining({ message: 'store unavailable' }),
  });

  const long = 'y'.repeat(200_000);
  const { ledger } = setup(answering(long), { maxPayloadBytes: 65_536 });
  const answered = await ledger.complete({ ...input, idempotencyKey: 'long' }, {});
  expect(answered.outcome).toBe('succeeded');
  expect(answered.text).toHaveLength(200_000);
  expect(answered.receiptError).toBeUndefined();
});

test('invocationJson handles undefined, BigInt, circular plain objects, and shared DAG references', () => {
  expect(invocationJson(undefined)).toBeNull();
  expect(invocationJson({ count: 9007199254740993n })).toEqual({ count: '9007199254740993' });

  const cyclic: Record<string, unknown> = { label: 'root' };
  cyclic.self = cyclic;
  expect(invocationJson(cyclic)).toEqual({ label: 'root', self: '[Circular]' });

  const shared = { ok: true };
  expect(invocationJson([shared, shared])).toEqual([{ ok: true }, { ok: true }]);
});

test('streamEvidence trims thousands of small stream parts in linear O(N) time', async () => {
  const store = createMemoryAgentRuntimeStore();
  const models = defineModelRegistry({
    models: { model: descriptor },
    providers: {
      mock: {
        create: () => ({
          provider: 'mock',
          modelId: 'model',
          async stream() {
            return {
              parts: {
                async *[Symbol.asyncIterator]() {
                  yield { type: 'text-start' as const, id: 't' };
                  for (let i = 0; i < 5_000; i += 1) {
                    yield { type: 'text-delta' as const, id: 't', delta: `c${i % 10}` };
                  }
                  yield { type: 'text-end' as const, id: 't' };
                  yield {
                    type: 'finish' as const,
                    finishReason: 'stop' as const,
                    rawFinishReason: 'r'.repeat(800),
                    usage: {
                      inputTokens: { value: 8, provenance: 'provider-reported' as const },
                      outputTokens: { value: 2, provenance: 'provider-reported' as const },
                    },
                  };
                },
              },
            };
          },
        }),
      },
    },
  });
  const ledger = createModelInvocationLedger({
    store,
    models,
    payloadKey: randomBytes(32),
    maxPayloadBytes: 4_096,
    authorize: () => ({ subject: 'verified' }),
  });
  const started = performance.now();
  const result = await ledger.complete(
    { ...input, idempotencyKey: 'linear', timeoutMs: 5_000 },
    {},
  );
  const elapsedMs = performance.now() - started;
  expect(result.outcome).toBe('succeeded');
  expect(result.text).toHaveLength(10_000);
  expect(elapsedMs).toBeLessThan(1_000);
});
