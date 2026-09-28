import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simulateReadableStream, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  type CompletionInvocationInput,
  CompletionInvocationInputSchema,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  createModelInvocationLedger,
  currentModelInvocationAttempt,
  defineAgentProtocol,
  defineModelRegistry,
  type ModelInvocationAttemptContext,
  type ModelInvocationConfig,
} from '../src/entrypoints/agent-runtime';
import { openRouterProvider } from '../src/entrypoints/agent-runtime/openrouter';
import { createBunSqliteAgentRuntimeStore } from '../src/entrypoints/agent-runtime/sqlite/bun';

type MockPart =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<
    infer T
  >
    ? T
    : never;

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};
const trace = {
  operationId: 'operation-1',
  purpose: 'summarize',
  project: 'test-project',
  parent: { traceId: 'trace-1', invocationId: 'parent-1' },
  experiment: 'test-1',
  case: 'case-1',
  profile: 'small',
};
const input: CompletionInvocationInput = {
  conversationId: 'conversation-1',
  idempotencyKey: 'key-1',
  trace,
  prompt: 'Only this private prompt.',
  models: ['first'],
  timeoutMs: 1_000,
};
const authorize: ModelInvocationConfig['authorize'] = ({ context, action }) => {
  if (context !== 'trusted' || (action === 'read-payload' && context !== 'trusted'))
    throw new Error('Forbidden caller');
  return { subject: 'verified-caller' };
};
const modelDescriptor = {
  provider: 'test',
  modelId: 'requested-model',
  contextWindow: 8_000,
  capabilities: [],
};
function successModel() {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'answer' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage,
      warnings: [],
      response: { id: 'response-1', modelId: 'effective-model' },
    }),
  });
}
function registry(first = successModel(), second = successModel()) {
  return defineModelRegistry({
    models: {
      first: modelDescriptor,
      second: { ...modelDescriptor, modelId: 'fallback-model' },
    },
    providers: { test: { create: (id) => (id === 'fallback-model' ? second : first) } },
  });
}

describe('public completion and agent invocation receipts', () => {
  test('real provider wire contains only the completion prompt, with transport IDs and unknown usage', async () => {
    const store = createMemoryAgentRuntimeStore();
    const wire: unknown[] = [];
    const contexts: (ModelInvocationAttemptContext | undefined)[] = [];
    const provider = openRouterProvider({
      apiKey: 'private-fixture-key',
      fetch: Object.assign(
        async (_url: unknown, init?: RequestInit) => {
          wire.push(JSON.parse(String(init?.body)));
          contexts.push(currentModelInvocationAttempt());
          return Response.json({
            id: 'wire-response',
            model: 'actual-model',
            provider: 'actual-provider',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'wire answer' },
                finish_reason: 'stop',
              },
            ],
          });
        },
        {
          preconnect() {
            /* The transport fixture performs no network I/O. */
          },
        },
      ),
    });
    const models = defineModelRegistry({
      models: { first: { ...modelDescriptor, provider: 'gateway' } },
      providers: { gateway: provider },
    });
    const ledger = createModelInvocationLedger({
      store,
      models,
      payloadKey: randomBytes(32),
      authorize,
    });
    const result = await ledger.complete(input, 'trusted');
    expect(result.outcome).toBe('succeeded');
    expect(result.text).toBe('wire answer');
    expect(wire).toHaveLength(1);
    expect(wire[0]).toMatchObject({ messages: [{ role: 'user', content: input.prompt }] });
    const body = z.record(z.string(), z.unknown()).parse(wire[0]);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(contexts[0]?.invocationId).toBe(result.invocationId);
    expect(contexts[0]?.operationId).toBe(trace.operationId);
    expect(currentModelInvocationAttempt()).toBeUndefined();
    const page = await ledger.read(
      { conversationId: input.conversationId, limit: 100 },
      'trusted',
    );
    expect(page.items.map((item) => item.record.type)).toEqual([
      'invocation/started',
      'provider/request',
      'provider/response',
      'invocation/finished',
    ]);
    const response = page.items.find(
      (item) => item.record.type === 'provider/response',
    )?.record;
    if (response?.type !== 'provider/response') throw new Error('Missing response receipt');
    const transport = contexts[0];
    if (!transport) throw new Error('Missing transport context');
    expect(response.attemptId).toBe(transport.attemptId);
    expect(response.effective.modelId).toBe('actual-model');
    expect(response.usage.inputTokens).toEqual({ provenance: 'unavailable' });
    expect(response.usage.outputTokens).toEqual({ provenance: 'unavailable' });
    expect(response.usage.cost).toEqual({ provenance: 'unavailable' });
    const events = await store.readEvents({
      conversationId: input.conversationId,
      limit: 100,
    });
    const journal = JSON.stringify(events);
    expect(journal.includes(input.prompt)).toBe(false);
    expect(journal).not.toContain('private-fixture-key');
    expect(journal).not.toContain('wire answer');
    const request = page.items.find((item) => item.record.type === 'provider/request')?.record;
    if (request?.type !== 'provider/request') throw new Error('Missing request receipt');
    const payload = await ledger.readPayload(
      { conversationId: input.conversationId, artifactId: request.sent.artifactId },
      'trusted',
    );
    expect(JSON.stringify(payload)).toContain(input.prompt);
    expect(JSON.stringify(payload)).not.toContain('private-fixture-key');
    await expect(
      ledger.readPayload(
        { conversationId: input.conversationId, artifactId: request.sent.artifactId },
        'spoof',
      ),
    ).rejects.toThrow('Forbidden');
    const wrongKey = createModelInvocationLedger({
      store,
      models,
      payloadKey: randomBytes(32),
      authorize,
    });
    await expect(
      wrongKey.readPayload(
        { conversationId: input.conversationId, artifactId: request.sent.artifactId },
        'trusted',
      ),
    ).rejects.toThrow();
  });

  test('caller spoof and unauthorized reads refuse before provider execution', async () => {
    const model = successModel();
    const store = createMemoryAgentRuntimeStore();
    const ledger = createModelInvocationLedger({
      store,
      models: registry(model),
      payloadKey: randomBytes(32),
      authorize,
    });
    expect(
      CompletionInvocationInputSchema.safeParse({
        ...input,
        caller: { subject: 'verified-caller' },
      }).success,
    ).toBe(false);
    await expect(ledger.complete(input, { subject: 'verified-caller' })).rejects.toThrow(
      'Forbidden',
    );
    await expect(
      ledger.read({ conversationId: input.conversationId, limit: 100 }, 'spoof'),
    ).rejects.toThrow('Forbidden');
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(
      (await store.readEvents({ conversationId: input.conversationId, limit: 100 })).items,
    ).toHaveLength(0);
  });

  test('durable idempotency fences concurrent callers and survives SQLite reopen and archive restore', async () => {
    const filename = join(tmpdir(), `stitchkit-invocations-${crypto.randomUUID()}.sqlite`);
    const key = randomBytes(32);
    let sqlite = createBunSqliteAgentRuntimeStore({ filename });
    const model = successModel();
    const models = registry(model);
    try {
      const first = createModelInvocationLedger({
        store: sqlite.store,
        models,
        payloadKey: key,
        authorize,
      });
      const other = createModelInvocationLedger({
        store: sqlite.store,
        models,
        payloadKey: key,
        authorize,
      });
      const results = await Promise.all([
        first.complete(input, 'trusted'),
        other.complete(input, 'trusted'),
      ]);
      expect(results.map((result) => result.outcome).sort()).toEqual([
        'duplicate',
        'succeeded',
      ]);
      expect(results[0]?.invocationId).toBe(results[1]?.invocationId);
      expect(model.doGenerateCalls).toHaveLength(1);
      await expect(other.complete({ ...input, prompt: 'changed' }, 'trusted')).rejects.toThrow(
        'conflicts',
      );
      const archive = await sqlite.store.exportConversation(input.conversationId);
      sqlite.close();
      sqlite = createBunSqliteAgentRuntimeStore({ filename });
      const reopened = createModelInvocationLedger({
        store: sqlite.store,
        models,
        payloadKey: key,
        authorize,
      });
      expect((await reopened.complete(input, 'trusted')).outcome).toBe('duplicate');
      const restored = createMemoryAgentRuntimeStore();
      await restored.importConversation(archive);
      const imported = createModelInvocationLedger({
        store: restored,
        models,
        payloadKey: key,
        authorize,
      });
      expect((await imported.complete(input, 'trusted')).outcome).toBe('duplicate');
      expect(model.doGenerateCalls).toHaveLength(1);
    } finally {
      sqlite.close();
      await rm(filename, { force: true });
      await rm(`${filename}-wal`, { force: true });
      await rm(`${filename}-shm`, { force: true });
    }
  });

  test('fallback has separate attempts, measured usage and no invented effective identity', async () => {
    const failed = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('private upstream failure');
      },
    });
    const succeeded = successModel();
    const store = createMemoryAgentRuntimeStore();
    const contexts: ModelInvocationAttemptContext[] = [];
    const ledger = createModelInvocationLedger({
      store,
      models: registry(failed, succeeded),
      payloadKey: randomBytes(32),
      authorize,
      onAttempt: (context) => {
        contexts.push(context);
      },
    });
    const result = await ledger.complete({ ...input, models: ['first', 'second'] }, 'trusted');
    expect(result.outcome).toBe('succeeded');
    expect(failed.doGenerateCalls).toHaveLength(1);
    expect(succeeded.doGenerateCalls).toHaveLength(1);
    expect(new Set(contexts.map((value) => value.attemptId)).size).toBe(2);
    const { items } = await ledger.read(
      { conversationId: input.conversationId, limit: 100 },
      'trusted',
    );
    const responses = items.flatMap(({ record }) =>
      record.type === 'provider/response' ? [record] : [],
    );
    expect(responses).toHaveLength(2);
    expect(responses[0]).toMatchObject({
      status: 'failed',
      effective: { modelId: null, provider: null, responseId: null },
      usage: { inputTokens: { provenance: 'unavailable' } },
    });
    expect(responses[1]).toMatchObject({
      status: 'succeeded',
      effective: { modelId: 'effective-model' },
      usage: { inputTokens: { value: 3, provenance: 'provider-reported' } },
    });
    expect(JSON.stringify(items)).not.toContain('private upstream failure');
  });

  test('agent keeps its two-step tool loop and shares the completion query and causal IDs', async () => {
    const store = createMemoryAgentRuntimeStore();
    const models = registry();
    const ledger = createModelInvocationLedger({
      store,
      models,
      payloadKey: randomBytes(32),
      authorize,
    });
    await ledger.complete(input, 'trusted');
    let step = 0;
    let toolCalls = 0;
    const contextIds: (ModelInvocationAttemptContext | undefined)[] = [];
    const model = new MockLanguageModelV4({
      doStream: async () => {
        contextIds.push(currentModelInvocationAttempt());
        step += 1;
        return {
          stream: simulateReadableStream<MockPart>({
            chunks:
              step === 1
                ? [
                    { type: 'tool-call', toolCallId: 'tool-1', toolName: 'echo', input: '{}' },
                    {
                      type: 'finish',
                      finishReason: { unified: 'tool-calls', raw: undefined },
                      usage,
                    },
                  ]
                : [
                    {
                      type: 'response-metadata',
                      id: 'agent-response',
                      modelId: 'agent-effective',
                    },
                    { type: 'text-start', id: 'text-1' },
                    { type: 'text-delta', id: 'text-1', delta: 'done' },
                    { type: 'text-end', id: 'text-1' },
                    {
                      type: 'finish',
                      finishReason: { unified: 'stop', raw: undefined },
                      usage,
                    },
                  ],
          }),
        };
      },
    });
    const runtime = createAgentRuntime({
      store,
      protocol: defineAgentProtocol({
        context: z.literal('trusted'),
        inputMetadata: z.object({}),
      }),
      models: { resolve: () => ({ descriptor: modelDescriptor, model }) },
      prompt: () => ({
        instructions: 'agent policy',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({
        echo: tool({
          inputSchema: z.object({}),
          execute: async () => {
            toolCalls += 1;
            return 'ok';
          },
        }),
      }),
      invocations: { ledger, trace: () => trace },
    });
    try {
      const result = await runtime.submit({
        conversationId: input.conversationId,
        idempotencyKey: 'agent-input',
        context: 'trusted',
        parts: [{ type: 'text', text: 'agent request' }],
      }).result;
      expect(result.reason).toBe('success');
      expect(toolCalls).toBe(1);
      expect(model.doStreamCalls).toHaveLength(2);
      const { items } = await ledger.read(
        { conversationId: input.conversationId, limit: 100 },
        'trusted',
      );
      const starts = items.flatMap(({ record }) =>
        record.type === 'invocation/started' ? [record] : [],
      );
      expect(starts.map((record) => record.mode)).toEqual(['completion', 'agent']);
      const agent = starts.find((record) => record.mode === 'agent');
      expect(agent?.runId).toBe(result.run.id);
      expect(agent?.trace).toEqual(trace);
      const attempts = items.flatMap(({ record }) =>
        record.type === 'provider/request' ? [record] : [],
      );
      expect(attempts).toHaveLength(3);
      expect(
        contextIds.every(
          (context) =>
            context?.runId === result.run.id && context.invocationId === agent?.invocationId,
        ),
      ).toBe(true);
      expect((await ledger.complete(input, 'trusted')).outcome).toBe('duplicate');
    } finally {
      await runtime.close();
    }
  });
});
