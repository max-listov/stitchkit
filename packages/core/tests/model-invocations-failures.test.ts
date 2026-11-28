import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  currentModelInvocationAttempt,
  wrapInvocationDriver,
} from '../src/agent-runtime/invocation-attempt';
import { createInvocationPayloads } from '../src/agent-runtime/invocation-payload';
import { hasProviderOrigin } from '../src/agent-runtime/provider-origin';
import {
  type AgentModelDriver,
  type AgentModelStreamPart,
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
  prompt: 'private-prompt',
  timeoutMs: 20,
};
const usage = {
  inputTokens: { total: 8, noCache: 8, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};
function setup(
  model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: 'ok' },
          { type: 'text-end', id: 't' },
          { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
        ],
      }),
    }),
  }),
  extra: Partial<ModelInvocationConfig> = {},
) {
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
  expect(refused.model.doStreamCalls).toHaveLength(0);
  const audit = setup(undefined, {
    onAttempt: () => {
      throw new Error('audit unavailable');
    },
  });
  expect(
    (await audit.ledger.complete({ ...input, models: ['model', 'model'] }, {})).outcome,
  ).toBe('failed');
  expect(audit.model.doStreamCalls).toHaveLength(0);
  const records = (await audit.ledger.read({ conversationId: 'conv', limit: 100 }, {})).items;
  expect(records.filter(({ record }) => record.type === 'provider/request')).toHaveLength(1);
  expect(records.filter(({ record }) => record.type === 'provider/response')).toHaveLength(1);
});

test('timeout and pre-abort end truthfully and do not try a fallback', async () => {
  const model = new MockLanguageModelV4({
    doStream: ({ abortSignal }) =>
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
  expect(model.doStreamCalls).toHaveLength(1);
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
  expect(model.doStreamCalls).toHaveLength(1);
});

test('payload limits, missing atomic admission and wrong stores fail closed', async () => {
  const limited = setup(undefined, { maxPayloadBytes: 1_024 });
  const oversized = await limited.ledger.complete(
    { ...input, prompt: 'x'.repeat(10_000) },
    {},
  );
  expect(oversized.outcome).toBe('succeeded');
  expect(oversized.receiptError).toBeInstanceOf(RangeError);
  expect(limited.model.doStreamCalls).toHaveLength(1);
  const limitedRecords = (
    await limited.ledger.read({ conversationId: 'conv', limit: 100 }, {})
  ).items;
  const limitedRequest = limitedRecords.find(
    ({ record }) => record.type === 'provider/request',
  )?.record;
  expect(limitedRequest).toMatchObject({
    type: 'provider/request',
    sent: { payloadOmitted: 'max-payload-bytes' },
  });
  if (limitedRequest?.type === 'provider/request') {
    expect(limitedRequest.sent.artifactId).toBeUndefined();
  }
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
    doStream: async () => {
      calls += 1;
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: 'output' },
            { type: 'text-end', id: 't' },
            {
              type: 'finish',
              finishReason: { unified: calls === 1 ? 'error' : 'stop', raw: undefined },
              usage,
            },
          ],
        }),
      };
    },
  });
  const fallback = setup(model);
  expect(
    (
      await fallback.ledger.complete(
        { ...input, models: ['model', 'model'], timeoutMs: 2_000 },
        {},
      )
    ).outcome,
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

test('auditedParts binds ALS in [Symbol.asyncIterator]() and throw(), records cancelled on clean abort, and marks iterator init errors', async () => {
  const store = createMemoryAgentRuntimeStore();
  const payloads = createInvocationPayloads(store, randomBytes(32), 65_536);
  const sampleRequest = {
    instructions: [],
    messages: [{ role: 'user' as const, content: 'hi' }],
    tools: [],
    settings: {},
    correlation: { conversationId: 'conv-audit', attemptId: 'att-0', step: 0 },
  };
  const makeWriter = () => {
    const records: Array<{ type: string; status?: string }> = [];
    return {
      records,
      writer: {
        identity: { conversationId: 'conv-audit', invocationId: 'inv-1', operationId: 'op-1' },
        process: { instanceId: 'inst', pid: process.pid, hostname: 'localhost' },
        payloads,
        receiptErrors: [] as unknown[],
        async append(record: { type: string; status?: string }) {
          records.push(record);
        },
      },
    };
  };

  // 1. Synchronous throw from source[Symbol.asyncIterator]() runs inside ALS, marks provider origin, and records failed response.
  let initAttemptId: string | undefined;
  const syncBoom = new Error('iterator init failed');
  const failingInitDriver: AgentModelDriver = {
    provider: 'mock',
    modelId: 'model',
    async stream() {
      return {
        parts: {
          [Symbol.asyncIterator]() {
            initAttemptId = currentModelInvocationAttempt()?.attemptId;
            throw syncBoom;
          },
        },
      };
    },
  };
  const w1 = makeWriter();
  const wrapped1 = wrapInvocationDriver(
    w1.writer,
    { descriptor, driver: failingInitDriver },
    0,
  );
  const s1 = await wrapped1.stream(sampleRequest, new AbortController().signal);
  let caughtInit: unknown;
  try {
    s1.parts[Symbol.asyncIterator]();
  } catch (error) {
    caughtInit = error;
  }
  await Bun.sleep(10);
  expect(caughtInit).toBe(syncBoom);
  expect(hasProviderOrigin(caughtInit)).toBe(true);
  expect(initAttemptId).toBeDefined();
  expect(w1.records.some((r) => r.type === 'provider/response' && r.status === 'failed')).toBe(
    true,
  );

  // 2. Clean next.done after abortSignal.aborted records 'cancelled' (NOT 'failed').
  const controller = new AbortController();
  const cleanAbortDriver: AgentModelDriver = {
    provider: 'mock',
    modelId: 'model',
    async stream() {
      return {
        parts: {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                controller.abort(new Error('stopped'));
                return { done: true as const, value: undefined };
              },
            };
          },
        },
      };
    },
  };
  const w2 = makeWriter();
  const wrapped2 = wrapInvocationDriver(
    w2.writer,
    { descriptor, driver: cleanAbortDriver },
    0,
  );
  const s2 = await wrapped2.stream(sampleRequest, controller.signal);
  for await (const _part of s2.parts) {
    // empty
  }
  expect(
    w2.records.some((r) => r.type === 'provider/response' && r.status === 'cancelled'),
  ).toBe(true);

  // 3. iterator.throw() executes inside ALS and records provider/response in finally.
  let throwAttemptId: string | undefined;
  const throwDriver: AgentModelDriver = {
    provider: 'mock',
    modelId: 'model',
    async stream() {
      return {
        parts: {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<AgentModelStreamPart>> {
                return { done: false, value: { type: 'ping' } };
              },
              async throw(err: unknown): Promise<IteratorResult<AgentModelStreamPart>> {
                throwAttemptId = currentModelInvocationAttempt()?.attemptId;
                throw err;
              },
            };
          },
        },
      };
    },
  };
  const w3 = makeWriter();
  const wrapped3 = wrapInvocationDriver(w3.writer, { descriptor, driver: throwDriver }, 0);
  const s3 = await wrapped3.stream(sampleRequest, new AbortController().signal);
  const iter3 = s3.parts[Symbol.asyncIterator]();
  const injectedErr = new Error('consumer injected throw');
  await expect(iter3.throw?.(injectedErr)).rejects.toBe(injectedErr);
  expect(throwAttemptId).toBeDefined();
  expect(w3.records.some((r) => r.type === 'provider/response' && r.status === 'failed')).toBe(
    true,
  );
});

test('commitRunTerminal failure still closes invocation/started with invocation/finished', async () => {
  const baseStore = createMemoryAgentRuntimeStore();
  const failingCommitStore: typeof baseStore = {
    ...baseStore,
    async commitRunTerminal() {
      throw new Error('terminal commit storage outage');
    },
  };
  const ledger = createModelInvocationLedger({
    store: failingCommitStore,
    payloadKey: randomBytes(32),
    authorize: () => ({ subject: 'user-1' }),
    models: defineModelRegistry({
      providers: {},
      models: {},
    }),
  });
  const runtime = createAgentRuntime({
    protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
    store: failingCommitStore,
    invocations: {
      ledger,
      trace: () => ({ operationId: 'op-fail', project: 'proj', purpose: 'agent' }),
    },
    models: {
      resolve: () => ({
        descriptor,
        driver: {
          provider: 'mock',
          modelId: 'model',
          async stream() {
            return {
              parts: (async function* (): AsyncIterable<AgentModelStreamPart> {
                yield { type: 'text-delta', id: 't1', delta: 'hello' };
                yield {
                  type: 'finish',
                  finishReason: 'stop',
                  usage: {
                    inputTokens: { value: 5, provenance: 'provider-reported' },
                    outputTokens: { value: 2, provenance: 'provider-reported' },
                  },
                };
              })(),
            };
          },
        },
      }),
    },
    prompt: () => ({
      instructions: 'sys',
      sections: [],
      instructionTokens: { provenance: 'unavailable' },
      contextDecision: 'unavailable',
    }),
    tools: () => ({}),
  });

  await expect(
    runtime.submit({
      conversationId: 'conv-commit-fail',
      idempotencyKey: 'k-commit-fail',
      context: {},
      parts: [{ type: 'text', text: 'hi' }],
      metadata: {},
    }).result,
  ).rejects.toThrow();
  await runtime.close();

  const records = (
    await ledger.read({ conversationId: 'conv-commit-fail', limit: 20 }, { authorization: {} })
  ).items;
  expect(records.some(({ record }) => record.type === 'invocation/started')).toBe(true);
  expect(
    records.some(
      ({ record }) => record.type === 'invocation/finished' && record.status === 'failed',
    ),
  ).toBe(true);
});
