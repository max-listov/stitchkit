import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { openRouterProvider } from '../src/agent-runtime/openrouter';
import { addUsage } from '../src/agent-runtime/runtime-internals';
import { createBunSqliteAgentRuntimeStore } from '../src/agent-runtime/sqlite-bun';
import {
  AgentProviderStreamCutError,
  type AgentRunEvent,
  AgentRuntimeConflictError,
  type AgentStepSpend,
  AgentStepSpendPhaseSchema,
  AgentStepSpendSchema,
  type AgentUsage,
  agentChildBudgetStopPolicy,
  createAgentChildManager,
  createAgentObservability,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  createModelInvocationLedger,
  defineAgentProtocol,
  defineModelRegistry,
} from '../src/entrypoints/agent-runtime';
import { fromAiSdkModel } from '../src/entrypoints/agent-runtime/ai-sdk';
import { createScriptedModelDriver } from '../src/entrypoints/agent-runtime/testing';
import { defineAgentTool } from '../src/entrypoints/tools';
import { expectTimerRefusal } from './support/timer-refusal';

/** The spend fact inside a hook input, without the run context that travels around it. */
function spendOf(input: AgentStepSpend): AgentStepSpend {
  const base = {
    conversationId: input.conversationId,
    runId: input.runId,
    step: input.step,
    attempt: input.attempt,
    usage: input.usage,
    ...(input.trace !== undefined && { trace: input.trace }),
  };
  return AgentStepSpendSchema.parse(
    input.phase === 'compaction'
      ? { ...base, phase: input.phase }
      : {
          ...base,
          phase: input.phase,
          model: input.model,
          provider: input.provider,
          response: input.response,
        },
  );
}

const sdkUsage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

const reported = (value: number) => ({ value, provenance: 'provider-reported' as const });

function normalizePricedUsage({
  usage,
  providerMetadata,
}: {
  usage: { inputTokens?: number; outputTokens?: number };
  providerMetadata?: unknown;
}): AgentUsage {
  const meta = providerMetadata as { openrouter?: { usage?: { cost?: number } } } | undefined;
  const cost = meta?.openrouter?.usage?.cost;
  return {
    inputTokens: reported(usage.inputTokens ?? 0),
    outputTokens: reported(usage.outputTokens ?? 0),
    cost:
      cost !== undefined
        ? { value: cost, currency: 'USD', provenance: 'provider-reported' }
        : { provenance: 'unavailable' },
  };
}

function readMockUpstream({
  providerMetadata,
}: {
  providerMetadata?: unknown;
}): string | undefined {
  const meta = providerMetadata as { openrouter?: { provider?: unknown } } | undefined;
  return typeof meta?.openrouter?.provider === 'string' ? meta.openrouter.provider : undefined;
}

function openRouterFixtureProvider(
  respond: () => {
    chunks: Record<string, unknown>[];
  },
) {
  return openRouterProvider({
    apiKey: 'fixture',
    fetch: Object.assign(
      async () => {
        const { chunks } = respond();
        return new Response(
          `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
      {
        preconnect() {
          /* Fixture performs no network I/O. */
        },
      },
    ),
  });
}

describe('step spend hook and unified spend recording', () => {
  test('a retried step records abandoned-attempt and step facts whose sum equals run.usage, after writing provider/response', async () => {
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls += 1;
        const chunks: Record<string, unknown>[] =
          calls === 1
            ? [
                {
                  type: 'response-metadata',
                  id: 'failed-gen',
                  modelId: 'retry-model',
                  timestamp: new Date(0),
                },
                { type: 'text-start', id: 'a' },
                { type: 'text-delta', id: 'a', delta: 'partial' },
                { type: 'error', error: new AgentProviderStreamCutError() },
                {
                  type: 'finish',
                  finishReason: { unified: 'error', raw: undefined },
                  usage: sdkUsage(70, 7),
                  providerMetadata: {
                    openrouter: { provider: 'FirstProvider', usage: { cost: 0.07 } },
                  },
                },
              ]
            : [
                {
                  type: 'response-metadata',
                  id: 'recovered-gen',
                  modelId: 'retry-model',
                  timestamp: new Date(1),
                },
                { type: 'text-start', id: 'b' },
                { type: 'text-delta', id: 'b', delta: 'recovered' },
                { type: 'text-end', id: 'b' },
                {
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: undefined },
                  usage: sdkUsage(30, 3),
                  providerMetadata: {
                    openrouter: { provider: 'SecondProvider', usage: { cost: 0.03 } },
                  },
                },
              ];
        return { stream: simulateReadableStream({ chunks } as never) };
      },
    });

    const store = createMemoryAgentRuntimeStore();
    const observed: AgentRunEvent[] = [];
    const facts: Array<{
      spend: AgentStepSpend;
      workspace: string;
      persistedResponsesAtHookTime: number;
    }> = [];
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({
        context: z.strictObject({ workspace: z.string() }),
        inputMetadata: z.strictObject({}),
      }),
      store,
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'gateway',
            modelId: 'retry-model',
            contextWindow: 16_000,
            capabilities: [],
          },
          driver: fromAiSdkModel(model, {
            normalizeUsage: normalizePricedUsage,
            resolveResponseProvider: readMockUpstream,
          }),
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
      observe: createAgentObservability({
        write: (event) => {
          observed.push(event);
        },
      }),
      onStepSpend: async (input) => {
        const persisted = (
          await store.readEvents({ conversationId: input.conversationId, limit: 100 })
        ).items.filter((event) => event.kind === 'provider/response');
        facts.push({
          spend: spendOf(input),
          workspace: input.context.workspace,
          persistedResponsesAtHookTime: persisted.length,
        });
      },
    });

    const result = await runtime.submit({
      conversationId: 'conv-retry',
      idempotencyKey: 'retry-1',
      context: { workspace: 'ws-alpha' },
      parts: [{ type: 'text', text: 'go' }],
      metadata: {},
    }).result;
    await runtime.close();

    expect(result.reason).toBe('success');
    expect(facts).toHaveLength(2);
    expect(facts[0]).toMatchObject({
      workspace: 'ws-alpha',
      persistedResponsesAtHookTime: 1,
      spend: {
        conversationId: 'conv-retry',
        runId: result.run.id,
        step: 0,
        attempt: 1,
        phase: 'abandoned-attempt',
        model: 'retry-model',
        provider: { key: 'gateway', upstream: 'FirstProvider' },
        response: { id: 'failed-gen', provider: 'FirstProvider' },
        usage: {
          inputTokens: { value: 70, provenance: 'provider-reported' },
          outputTokens: { value: 7, provenance: 'provider-reported' },
          cost: { value: 0.07, currency: 'USD', provenance: 'provider-reported' },
        },
      },
    });
    expect(facts[1]).toMatchObject({
      workspace: 'ws-alpha',
      persistedResponsesAtHookTime: 2,
      spend: {
        conversationId: 'conv-retry',
        runId: result.run.id,
        step: 0,
        attempt: 2,
        phase: 'step',
        model: 'retry-model',
        provider: { key: 'gateway', upstream: 'SecondProvider' },
        response: { id: 'recovered-gen', provider: 'SecondProvider' },
        usage: {
          inputTokens: { value: 30, provenance: 'provider-reported' },
          outputTokens: { value: 3, provenance: 'provider-reported' },
          cost: { value: 0.03, currency: 'USD', provenance: 'provider-reported' },
        },
      },
    });

    const summed = facts.reduce<AgentUsage | undefined>(
      (total, entry) => addUsage(total, entry.spend.usage),
      undefined,
    );
    expect(summed).toEqual(result.run.usage);
    expect(summed).toEqual(result.metrics?.usage);

    // Non-audited provider/response records carry step usage.
    const responses = (
      await store.readEvents({ conversationId: 'conv-retry', limit: 100 })
    ).items.filter((event) => event.kind === 'provider/response');
    expect(responses).toHaveLength(2);
    expect(responses.map((event) => (event.payload as { usage?: AgentUsage }).usage)).toEqual([
      facts[0]?.spend.usage,
      facts[1]?.spend.usage,
    ]);

    // observe `step-finished` is built from the same spend facts and exposes `phase`.
    const stepEvents = observed.filter((event) => event.type === 'step-finished');
    expect(stepEvents.map((event) => event.phase)).toEqual(['abandoned-attempt', 'step']);
    expect(stepEvents.map((event) => event.usage)).toEqual(
      facts.map((entry) => entry.spend.usage),
    );
  });

  test('compaction spend and audited invocation trace.project reach onStepSpend and observe', async () => {
    const store = createMemoryAgentRuntimeStore();
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            {
              type: 'response-metadata',
              id: 'resp-1',
              modelId: 'traced-model',
              timestamp: new Date(0),
            },
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: 'done' },
            { type: 'text-end', id: 't' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: undefined },
              usage: sdkUsage(100, 20),
              providerMetadata: { openrouter: { usage: { cost: 0.2 } } },
            },
          ],
        } as never),
      }),
    });
    const models = defineModelRegistry({
      models: {
        traced: {
          provider: 'direct',
          modelId: 'traced-model',
          contextWindow: 16_000,
          capabilities: [],
        },
      },
      providers: {
        direct: {
          create: () => fromAiSdkModel(model, { normalizeUsage: normalizePricedUsage }),
        },
      },
    });
    const ledger = createModelInvocationLedger({
      store,
      models,
      payloadKey: randomBytes(32),
      authorize: () => ({ subject: 'user-1' }),
    });
    const observed: AgentRunEvent[] = [];
    const facts: Array<{
      spend: AgentStepSpend;
      runIdFromContext: string;
      selectedModelId: string | undefined;
      persistedResponsesAtHookTime: number;
    }> = [];
    const compactionUsage: AgentUsage = {
      inputTokens: reported(50),
      outputTokens: reported(10),
      cost: { value: 0.05, currency: 'USD', provenance: 'provider-reported' },
    };

    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({
        context: z.strictObject({ tenant: z.string() }),
        inputMetadata: z.strictObject({}),
      }),
      store,
      invocations: {
        ledger,
        trace: ({ context, run }) => ({
          operationId: run.id,
          purpose: 'chat',
          project: `proj:${context.tenant}`,
        }),
      },
      models: { resolve: () => models.resolve('traced') },
      prompt: () => ({
        instructions: 'compact',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({}),
      history: {
        compact: async ({ conversationId, store: runtimeStore }) => ({
          outcome: 'not_needed',
          snapshot: await runtimeStore.loadSnapshot(conversationId),
          attempts: 1,
          usage: compactionUsage,
        }),
      },
      observe: createAgentObservability({
        write: (event) => {
          observed.push(event);
        },
      }),
      onStepSpend: async (input) => {
        const persisted = (
          await store.readEvents({ conversationId: input.conversationId, limit: 100 })
        ).items.filter((event) => event.kind === 'provider/response');
        facts.push({
          spend: spendOf(input),
          runIdFromContext: input.run.id,
          selectedModelId: input.selectedModel?.descriptor.modelId,
          persistedResponsesAtHookTime: persisted.length,
        });
      },
    });

    const result = await runtime.submit({
      conversationId: 'conv-compact',
      idempotencyKey: 'compact-1',
      context: { tenant: 'acme' },
      parts: [{ type: 'text', text: 'hi' }],
      metadata: {},
    }).result;
    await runtime.close();

    expect(result.reason).toBe('success');
    expect(facts.map((entry) => entry.spend.phase)).toEqual(['compaction', 'step']);
    expect(facts[0]?.spend.trace?.project).toBe('proj:acme');
    expect(facts[1]?.spend.trace?.project).toBe('proj:acme');
    // A compaction is the application's own call: it names no model, provider or response on spend,
    // while `selectedModel` is already resolved on the run context so compaction knows the context window.
    expect(facts[0]?.spend).not.toHaveProperty('model');
    expect(facts[0]?.spend).not.toHaveProperty('response');
    expect(facts[0]?.selectedModelId).toBe('traced-model');
    expect(facts[1]?.selectedModelId).toBe('traced-model');
    expect(facts[0]?.runIdFromContext).toBe(result.run.id);
    expect(facts[1]?.runIdFromContext).toBe(result.run.id);
    // Audited mode writes one provider/response before `onStepSpend` fires on `step`, with no duplicate.
    expect(facts[0]?.persistedResponsesAtHookTime).toBe(0);
    expect(facts[1]?.persistedResponsesAtHookTime).toBe(1);
    const totalResponses = (
      await store.readEvents({ conversationId: 'conv-compact', limit: 100 })
    ).items.filter((event) => event.kind === 'provider/response');
    expect(totalResponses).toHaveLength(1);
    expect(facts[1]?.spend).toMatchObject({ phase: 'step', provider: { key: 'direct' } });

    const summed = facts.reduce<AgentUsage | undefined>(
      (total, entry) => addUsage(total, entry.spend.usage),
      undefined,
    );
    expect(summed).toEqual(result.run.usage);
    const stepEvents = observed.filter((event) => event.type === 'step-finished');
    expect(stepEvents.map((event) => event.phase)).toEqual(['compaction', 'step']);
    // The compaction names the step it prepared and none of a provider answer's fields;
    // the step names all of them. Both count their tries from one.
    const [compaction, step] = stepEvents;
    expect(compaction).toMatchObject({ phase: 'compaction', step: 0, attempt: 1 });
    expect(compaction).not.toHaveProperty('response');
    expect(compaction).not.toHaveProperty('provider');
    expect(compaction).not.toHaveProperty('modelId');
    expect(step).toMatchObject({
      phase: 'step',
      step: 0,
      attempt: 1,
      modelId: 'traced-model',
      provider: { key: 'direct' },
    });
    expect(step?.response?.id).toBeDefined();
  });

  test('OpenRouter with cost reports provider-reported; without cost reports unavailable (never 0); schema has no payment enum', async () => {
    const runOpenRouter = async (cost?: number) => {
      const provider = openRouterFixtureProvider(() => ({
        chunks: [
          {
            id: 'gen-or-1',
            provider: 'DeepInfra',
            choices: [
              { index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null },
            ],
          },
          {
            id: 'gen-or-1',
            provider: 'DeepInfra',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: 120,
              completion_tokens: 15,
              total_tokens: 135,
              ...(cost !== undefined && { cost }),
            },
          },
        ],
      }));
      const facts: AgentStepSpend[] = [];
      const runtime = createAgentRuntime({
        protocol: defineAgentProtocol({
          context: z.strictObject({}),
          inputMetadata: z.strictObject({}),
        }),
        store: createMemoryAgentRuntimeStore(),
        models: {
          resolve: () => ({
            descriptor: {
              provider: 'openrouter',
              modelId: 'fixture/model',
              contextWindow: 100_000,
              capabilities: [],
            },
            driver: provider.create('fixture/model'),
          }),
        },
        prompt: () => ({
          instructions: 'test',
          sections: [],
          instructionTokens: { provenance: 'unavailable' },
          contextDecision: 'unavailable',
        }),
        tools: () => ({}),
        onStepSpend: (input) => {
          facts.push(spendOf(input));
        },
      });
      await runtime.submit({
        conversationId: 'conv-or',
        idempotencyKey: `or-${cost ?? 'none'}`,
        context: {},
        parts: [{ type: 'text', text: 'hello' }],
        metadata: {},
      }).result;
      await runtime.close();
      return facts[0];
    };

    const priced = await runOpenRouter(0.0042);
    expect(priced?.usage.cost).toEqual({
      value: 0.0042,
      currency: 'USD',
      provenance: 'provider-reported',
    });
    expect(priced).toMatchObject({
      phase: 'step',
      provider: { key: 'openrouter', upstream: 'DeepInfra' },
    });
    expect('payment' in (priced ?? {})).toBe(false);

    const unpriced = await runOpenRouter(undefined);
    expect(unpriced?.usage.cost).toEqual({ provenance: 'unavailable' });
    expect(unpriced?.usage.cost?.value).toBeUndefined();

    // Schema strictly rejects any invented payment classification.
    expect(
      AgentStepSpendSchema.safeParse({
        ...priced,
        payment: 'key',
      }).success,
    ).toBe(false);
    expect(AgentStepSpendPhaseSchema.options).toEqual([
      'step',
      'abandoned-attempt',
      'compaction',
    ]);
  });

  test('a throwing or timing-out onStepSpend hook does not fail the run and reports to observe and onStepSpendError', async () => {
    const runWithHook = async (options: {
      hook: () => void | Promise<void>;
      includeInternalCause: boolean;
      stepSpendTimeoutMs?: number;
      onStepSpendError?: (failure: {
        spend: AgentStepSpend;
        error: unknown;
      }) => void | Promise<void>;
    }) => {
      const observed: AgentRunEvent[] = [];
      const errors: Array<{ spend: AgentStepSpend; error: unknown }> = [];
      const runtime = createAgentRuntime({
        protocol: defineAgentProtocol({
          context: z.strictObject({}),
          inputMetadata: z.strictObject({}),
        }),
        store: createMemoryAgentRuntimeStore(),
        models: {
          resolve: () => ({
            descriptor: {
              provider: 'test',
              modelId: 'm',
              contextWindow: 16_000,
              capabilities: [],
            },
            driver: fromAiSdkModel(
              new MockLanguageModelV4({
                doStream: async () => ({
                  stream: simulateReadableStream({
                    chunks: [
                      { type: 'text-start', id: 't' },
                      { type: 'text-delta', id: 't', delta: 'ok' },
                      { type: 'text-end', id: 't' },
                      {
                        type: 'finish',
                        finishReason: { unified: 'stop', raw: undefined },
                        usage: sdkUsage(10, 5),
                      },
                    ],
                  } as never),
                }),
              }),
            ),
          }),
        },
        prompt: () => ({
          instructions: 'test',
          sections: [],
          instructionTokens: { provenance: 'unavailable' },
          contextDecision: 'unavailable',
        }),
        tools: () => ({}),
        observe: createAgentObservability({
          includeInternalCause: options.includeInternalCause,
          write: (event) => {
            observed.push(event);
          },
        }),
        onStepSpend: options.hook,
        onStepSpendError: (failure) => {
          errors.push(failure);
          return options.onStepSpendError?.(failure);
        },
        ...(options.stepSpendTimeoutMs !== undefined && {
          stepSpendTimeoutMs: options.stepSpendTimeoutMs,
        }),
      });
      const result = await runtime.submit({
        conversationId: 'conv-err',
        idempotencyKey: 'err-1',
        context: {},
        parts: [{ type: 'text', text: 'go' }],
        metadata: {},
      }).result;
      await runtime.close();
      return { result, observed, errors };
    };

    // Case 1: hook throws — run stays `success`, default observe strips raw cause.
    const thrown = await runWithHook({
      hook: () => {
        throw new Error('spend ledger unavailable');
      },
      includeInternalCause: false,
    });
    expect(thrown.result.reason).toBe('success');
    expect(thrown.errors).toHaveLength(1);
    const thrownError = thrown.errors[0]?.error;
    expect(thrownError instanceof Error ? thrownError.message : undefined).toBe(
      'spend ledger unavailable',
    );
    const stepRedacted = thrown.observed.find((event) => event.type === 'step-finished');
    expect(stepRedacted?.spendHookError).toEqual({ code: 'hook_error' });

    // Case 2: includeInternalCause: true preserves raw cause in observe.
    const unredacted = await runWithHook({
      hook: async () => {
        throw new Error('secret hook failure');
      },
      includeInternalCause: true,
    });
    expect(unredacted.result.reason).toBe('success');
    const stepUnredacted = unredacted.observed.find((event) => event.type === 'step-finished');
    expect(stepUnredacted?.spendHookError?.code).toBe('hook_error');
    const unredactedCause = stepUnredacted?.spendHookError?.cause;
    expect(unredactedCause instanceof Error ? unredactedCause.message : undefined).toBe(
      'secret hook failure',
    );

    // Case 3: hook exceeds timeout — run stays `success` and reports `hook_timeout`.
    const timedOut = await runWithHook({
      hook: () => new Promise<void>(() => undefined),
      includeInternalCause: true,
      stepSpendTimeoutMs: 25,
    });
    expect(timedOut.result.reason).toBe('success');
    expect(timedOut.errors).toHaveLength(1);
    const timeoutError = timedOut.errors[0]?.error;
    expect(timeoutError instanceof Error ? timeoutError.message : undefined).toContain(
      'timed out',
    );
    const stepTimeout = timedOut.observed.find((event) => event.type === 'step-finished');
    expect(stepTimeout?.spendHookError?.code).toBe('hook_timeout');

    // Case 4: async hook within timeout is awaited before the run settles.
    let hookCompleted = false;
    const awaited = await runWithHook({
      hook: async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        hookCompleted = true;
      },
      includeInternalCause: false,
      stepSpendTimeoutMs: 500,
    });
    expect(awaited.result.reason).toBe('success');
    expect(hookCompleted).toBe(true);
    expect(awaited.errors).toHaveLength(0);
    expect(
      awaited.observed.find((event) => event.type === 'step-finished')?.spendHookError,
    ).toBeUndefined();

    // Case 5: late rejection after timeout does not trigger an unhandledRejection.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const lateReject = Promise.withResolvers<void>();
      const late = await runWithHook({
        hook: () => lateReject.promise,
        includeInternalCause: false,
        stepSpendTimeoutMs: 15,
      });
      expect(late.result.reason).toBe('success');
      lateReject.reject(new Error('rejected after timeout'));
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    // Case 6: a throwing onStepSpendError is isolated and observe still records spendHookError.
    const errorHookFails = await runWithHook({
      hook: () => {
        throw new Error('primary spend failure');
      },
      onStepSpendError: () => {
        throw new Error('error callback exploded');
      },
      includeInternalCause: false,
    });
    expect(errorHookFails.result.reason).toBe('success');
    // The reporter threw too: the event is the only report, and says so even to a sink
    // that is not shown the raw causes.
    expect(
      errorHookFails.observed.find((event) => event.type === 'step-finished')?.spendHookError,
    ).toEqual({ code: 'hook_error', reportFailed: true });

    // Case 6b: a reporter that never answers is bounded by the same timeout — a store
    // that hung the hook hangs its reporter too, and the step must not wait on it.
    const reporterHangs = await Promise.race([
      runWithHook({
        hook: () => new Promise<void>(() => undefined),
        onStepSpendError: () => new Promise<void>(() => undefined),
        includeInternalCause: true,
        stepSpendTimeoutMs: 15,
      }),
      Bun.sleep(2_000).then(() => 'hung' as const),
    ]);
    expect(reporterHangs).not.toBe('hung');
    const hungReport =
      reporterHangs === 'hung'
        ? undefined
        : reporterHangs.observed.find((event) => event.type === 'step-finished')
            ?.spendHookError;
    expect(hungReport).toMatchObject({ code: 'hook_timeout', reportFailed: true });
    expect(String(hungReport?.reportError)).toContain('onStepSpendError');

    // Case 7: invalid stepSpendTimeoutMs values are refused up front.
    // 2 ** 31 is past the timer ceiling, where the hook's deadline would fire at once.
    const create = (timers: {
      stepSpendTimeoutMs?: number;
      loop?: { idleTimeoutMs: number };
    }) =>
      createAgentRuntime({
        ...timers,
        protocol: defineAgentProtocol({
          context: z.strictObject({}),
          inputMetadata: z.strictObject({}),
        }),
        store: createMemoryAgentRuntimeStore(),
        models: {
          resolve: () => ({
            descriptor: {
              provider: 'test',
              modelId: 'm',
              contextWindow: 16_000,
              capabilities: [],
            },
            driver: createScriptedModelDriver({ steps: [] }),
          }),
        },
        prompt: () => ({
          instructions: 'test',
          sections: [],
          instructionTokens: { provenance: 'unavailable' },
          contextDecision: 'unavailable',
        }),
        tools: () => ({}),
      });
    for (const invalid of [0, -10, 1.5, 2 ** 31]) {
      expectTimerRefusal(
        () => create({ stepSpendTimeoutMs: invalid }),
        'stepSpendTimeoutMs',
        invalid,
      );
    }
    // The loop's idle deadline is the same rule.
    expectTimerRefusal(
      () => create({ loop: { idleTimeoutMs: 2 ** 31 } }),
      'idleTimeoutMs',
      2 ** 31,
    );
  });

  test('child USD budget stops on OpenRouter cost without a cost callback', async () => {
    const sqlite = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    let stepCalls = 0;
    const provider = openRouterFixtureProvider(() => {
      stepCalls += 1;
      const isFinal = stepCalls >= 3;
      return {
        chunks: isFinal
          ? [
              {
                id: `gen-child-${stepCalls}`,
                provider: 'DeepInfra',
                choices: [
                  {
                    index: 0,
                    delta: { role: 'assistant', content: 'should not reach step 3' },
                    finish_reason: null,
                  },
                ],
              },
              {
                id: `gen-child-${stepCalls}`,
                provider: 'DeepInfra',
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                usage: {
                  prompt_tokens: 100,
                  completion_tokens: 10,
                  total_tokens: 110,
                  cost: 0.03,
                },
              },
            ]
          : [
              {
                id: `gen-child-${stepCalls}`,
                provider: 'DeepInfra',
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: 'assistant',
                      tool_calls: [
                        {
                          index: 0,
                          id: `call-${stepCalls}`,
                          type: 'function',
                          function: { name: 'ping', arguments: '{}' },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              },
              {
                id: `gen-child-${stepCalls}`,
                provider: 'DeepInfra',
                choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
                usage: {
                  prompt_tokens: 100,
                  completion_tokens: 10,
                  total_tokens: 110,
                  cost: 0.03,
                },
              },
            ],
      };
    });

    const children = createAgentChildManager({
      store: sqlite.store,
      host: sqlite.host,
      maxActiveChildren: 4,
      remainingBudget: () => ({ usd: 1 }),
      spawn: () => ({
        result: new Promise<{ resultReference?: string }>(() => undefined),
        stopPolicy: () => undefined,
      }),
    });

    try {
      await children.spawnChild({
        parentConversationId: 'parent-1',
        childConversationId: 'child-usd-1',
        childInput: { prompt: 'work' },
        budget: { usd: 0.05 },
      });

      const childRuntime = createAgentRuntime({
        protocol: defineAgentProtocol({
          context: z.strictObject({}),
          inputMetadata: z.strictObject({}),
        }),
        store: sqlite.store,
        models: {
          resolve: () => ({
            descriptor: {
              provider: 'openrouter',
              modelId: 'fixture/model',
              contextWindow: 100_000,
              capabilities: ['tools'],
            },
            driver: provider.create('fixture/model'),
          }),
        },
        prompt: () => ({
          instructions: 'child',
          sections: [],
          instructionTokens: { provenance: 'unavailable' },
          contextDecision: 'unavailable',
        }),
        tools: () => ({
          ping: defineAgentTool({
            description: 'ping',
            input: z.strictObject({}),
            execute: async () => 'pong',
          }),
        }),
        loop: {
          maxSteps: 5,
          stopPolicies: [
            agentChildBudgetStopPolicy({
              manager: children,
              childConversationId: 'child-usd-1',
            }),
          ],
        },
      });

      const terminal = await childRuntime.submit({
        conversationId: 'child-usd-1',
        idempotencyKey: 'child-run-1',
        context: {},
        parts: [{ type: 'text', text: 'start' }],
        metadata: {},
      }).result;
      await childRuntime.close();

      expect(terminal.reason).toBe('policy_stop');
      expect(terminal.policyName).toBe('child-budget');
      expect(stepCalls).toBe(2);
      const record = (await children.listChildren('parent-1'))[0];
      expect(record?.usage.usd).toBeCloseTo(0.06, 6);
    } finally {
      await sqlite.close();
    }
  });

  test('child USD budget refuses unavailable OpenRouter cost instead of treating it as zero', async () => {
    const sqlite = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    const provider = openRouterFixtureProvider(() => ({
      chunks: [
        {
          id: 'gen-child-unpriced',
          provider: 'DeepInfra',
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-unpriced-1',
                    type: 'function',
                    function: { name: 'ping', arguments: '{}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: 'gen-child-unpriced',
          provider: 'DeepInfra',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
        },
      ],
    }));
    const children = createAgentChildManager({
      store: sqlite.store,
      host: sqlite.host,
      maxActiveChildren: 4,
      remainingBudget: () => ({ usd: 1 }),
      spawn: () => ({
        result: new Promise<{ resultReference?: string }>(() => undefined),
        stopPolicy: () => undefined,
      }),
    });
    try {
      await children.spawnChild({
        parentConversationId: 'parent-unpriced',
        childConversationId: 'child-unpriced',
        childInput: {},
        budget: { usd: 0.05 },
      });
      const observed: AgentRunEvent[] = [];
      const childRuntime = createAgentRuntime({
        protocol: defineAgentProtocol({
          context: z.strictObject({}),
          inputMetadata: z.strictObject({}),
        }),
        store: sqlite.store,
        models: {
          resolve: () => ({
            descriptor: {
              provider: 'openrouter',
              modelId: 'fixture/model',
              contextWindow: 100_000,
              capabilities: ['tools'],
            },
            driver: provider.create('fixture/model'),
          }),
        },
        prompt: () => ({
          instructions: 'child',
          sections: [],
          instructionTokens: { provenance: 'unavailable' },
          contextDecision: 'unavailable',
        }),
        tools: () => ({
          ping: defineAgentTool({
            description: 'ping',
            input: z.strictObject({}),
            execute: async () => 'pong',
          }),
        }),
        loop: {
          maxSteps: 3,
          stopPolicies: [
            agentChildBudgetStopPolicy({
              manager: children,
              childConversationId: 'child-unpriced',
            }),
          ],
        },
        observe: createAgentObservability({
          includeInternalCause: true,
          write: (event) => {
            observed.push(event);
          },
        }),
      });
      const terminal = await childRuntime.submit({
        conversationId: 'child-unpriced',
        idempotencyKey: 'child-unpriced-1',
        context: {},
        parts: [{ type: 'text', text: 'start' }],
        metadata: {},
      }).result;
      await childRuntime.close();

      expect(terminal.reason).toBe('runtime_failure');
      const terminalEvent = observed.find((event) => event.type === 'run-terminal');
      const cause = terminalEvent?.internalCause;
      expect(cause instanceof Error ? cause.message : undefined).toContain(
        'Cannot enforce child USD budget without USD usage',
      );
    } finally {
      await sqlite.close();
    }
  });

  test('CAS conflict during operationLifecycle.finish still records billed step and compaction spend', async () => {
    // Part A: model step CAS conflict when recordRunOperation(phase='completed') rejects.
    {
      const base = createMemoryAgentRuntimeStore();
      const store: typeof base = {
        ...base,
        async recordRunOperation(input) {
          if (
            input.operation.kind === 'model-request' &&
            input.operation.phase === 'completed'
          ) {
            throw new AgentRuntimeConflictError('operation lifecycle');
          }
          return base.recordRunOperation(input);
        },
      };
      const observed: AgentRunEvent[] = [];
      const hookFacts: AgentStepSpend[] = [];
      const runtime = createAgentRuntime({
        protocol: defineAgentProtocol({
          context: z.strictObject({}),
          inputMetadata: z.strictObject({}),
        }),
        store,
        models: {
          resolve: () => ({
            descriptor: {
              provider: 'test',
              modelId: 'm',
              contextWindow: 16_000,
              capabilities: [],
            },
            driver: fromAiSdkModel(
              new MockLanguageModelV4({
                doStream: async () => ({
                  stream: simulateReadableStream({
                    chunks: [
                      { type: 'text-start', id: 't' },
                      { type: 'text-delta', id: 't', delta: 'paid answer' },
                      { type: 'text-end', id: 't' },
                      {
                        type: 'finish',
                        finishReason: { unified: 'stop', raw: undefined },
                        usage: sdkUsage(250, 40),
                      },
                    ],
                  } as never),
                }),
              }),
            ),
          }),
        },
        prompt: () => ({
          instructions: 'test',
          sections: [],
          instructionTokens: { provenance: 'unavailable' },
          contextDecision: 'unavailable',
        }),
        tools: () => ({}),
        observe: createAgentObservability({
          write: (event) => {
            observed.push(event);
          },
        }),
        onStepSpend: (input) => {
          hookFacts.push(spendOf(input));
        },
      });
      await runtime.submit({
        conversationId: 'conv-cas-step',
        idempotencyKey: 'cas-step-1',
        context: {},
        parts: [{ type: 'text', text: 'go' }],
        metadata: {},
      }).result;
      await runtime.close();

      expect(hookFacts).toHaveLength(1);
      expect(hookFacts[0]?.usage.inputTokens).toEqual({
        value: 250,
        provenance: 'provider-reported',
      });
      const stepEvent = observed.find((event) => event.type === 'step-finished');
      expect(stepEvent?.usage.inputTokens).toEqual({
        value: 250,
        provenance: 'provider-reported',
      });
      const terminalEvent = observed.find((event) => event.type === 'run-terminal');
      expect(terminalEvent?.usage.inputTokens.value).toBe(250);
      expect(terminalEvent?.usage.outputTokens.value).toBe(40);
    }

    // Part B: compaction CAS conflict when recordRunOperation(kind='compaction', phase='completed') rejects.
    {
      const base = createMemoryAgentRuntimeStore();
      const store: typeof base = {
        ...base,
        async recordRunOperation(input) {
          if (input.operation.kind === 'compaction' && input.operation.phase === 'completed') {
            throw new AgentRuntimeConflictError('compaction lifecycle');
          }
          return base.recordRunOperation(input);
        },
      };
      const observed: AgentRunEvent[] = [];
      const hookFacts: AgentStepSpend[] = [];
      const runtime = createAgentRuntime({
        protocol: defineAgentProtocol({
          context: z.strictObject({}),
          inputMetadata: z.strictObject({}),
        }),
        store,
        models: {
          resolve: () => ({
            descriptor: {
              provider: 'test',
              modelId: 'm',
              contextWindow: 16_000,
              capabilities: [],
            },
            driver: createScriptedModelDriver({ steps: [] }),
          }),
        },
        prompt: () => ({
          instructions: 'test',
          sections: [],
          instructionTokens: { provenance: 'unavailable' },
          contextDecision: 'unavailable',
        }),
        tools: () => ({}),
        history: {
          compact: async ({ conversationId, store: runtimeStore }) => ({
            outcome: 'not_needed',
            snapshot: await runtimeStore.loadSnapshot(conversationId),
            attempts: 1,
            usage: {
              inputTokens: reported(180),
              outputTokens: reported(25),
              cost: { value: 0.02, currency: 'USD', provenance: 'provider-reported' },
            },
          }),
        },
        observe: createAgentObservability({
          write: (event) => {
            observed.push(event);
          },
        }),
        onStepSpend: (input) => {
          hookFacts.push(spendOf(input));
        },
      });
      await runtime.submit({
        conversationId: 'conv-cas-compact',
        idempotencyKey: 'cas-compact-1',
        context: {},
        parts: [{ type: 'text', text: 'go' }],
        metadata: {},
      }).result;
      await runtime.close();

      expect(hookFacts).toHaveLength(1);
      expect(hookFacts[0]?.phase).toBe('compaction');
      expect(hookFacts[0]?.usage.inputTokens).toEqual({
        value: 180,
        provenance: 'provider-reported',
      });
      const stepEvent = observed.find((event) => event.type === 'step-finished');
      expect(stepEvent?.phase).toBe('compaction');
      const terminalEvent = observed.find((event) => event.type === 'run-terminal');
      expect(terminalEvent?.usage.inputTokens.value).toBe(180);
    }
  });

  test('custom normalizeUsage omitting cacheReadTokens keeps unavailable on both fact.usage and run.usage', async () => {
    const facts: AgentStepSpend[] = [];
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({
        context: z.strictObject({}),
        inputMetadata: z.strictObject({}),
      }),
      store: createMemoryAgentRuntimeStore(),
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'custom',
            modelId: 'm',
            contextWindow: 16_000,
            capabilities: [],
          },
          // Adapter intentionally omits `cacheReadTokens` while SDK stream emits `cacheRead: 0`.
          driver: fromAiSdkModel(
            new MockLanguageModelV4({
              doStream: async () => ({
                stream: simulateReadableStream({
                  chunks: [
                    { type: 'text-start', id: 't' },
                    { type: 'text-delta', id: 't', delta: 'ok' },
                    { type: 'text-end', id: 't' },
                    {
                      type: 'finish',
                      finishReason: { unified: 'stop', raw: undefined },
                      usage: {
                        inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
                        outputTokens: { total: 10, text: 10, reasoning: 0 },
                      },
                    },
                  ],
                } as never),
              }),
            }),
            {
              normalizeUsage: ({ usage }) => ({
                inputTokens: reported(usage.inputTokens ?? 0),
                outputTokens: reported(usage.outputTokens ?? 0),
              }),
            },
          ),
        }),
      },
      prompt: () => ({
        instructions: 'test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({}),
      onStepSpend: (input) => {
        facts.push(spendOf(input));
      },
    });
    const result = await runtime.submit({
      conversationId: 'conv-omitted-cache',
      idempotencyKey: 'omit-1',
      context: {},
      parts: [{ type: 'text', text: 'go' }],
      metadata: {},
    }).result;
    await runtime.close();

    expect(facts).toHaveLength(1);
    expect(facts[0]?.usage.cacheReadTokens).toEqual({ provenance: 'unavailable' });
    expect(result.run.usage?.cacheReadTokens).toEqual({ provenance: 'unavailable' });
    expect(result.metrics?.usage.cacheReadTokens).toEqual({ provenance: 'unavailable' });
  });

  test('sums multiple abandoned retry attempts and multi-step runs identically to run.usage', async () => {
    // 2 abandoned attempts + 1 successful step (maxAttempts: 3).
    {
      let calls = 0;
      const facts: AgentStepSpend[] = [];
      const runtime = createAgentRuntime({
        protocol: defineAgentProtocol({
          context: z.strictObject({}),
          inputMetadata: z.strictObject({}),
        }),
        store: createMemoryAgentRuntimeStore(),
        models: {
          resolve: () => ({
            descriptor: {
              provider: 'gateway',
              modelId: 'retry3',
              contextWindow: 16_000,
              capabilities: [],
            },
            driver: fromAiSdkModel(
              new MockLanguageModelV4({
                doStream: async () => {
                  calls += 1;
                  const failed = calls < 3;
                  const chunks: Record<string, unknown>[] = failed
                    ? [
                        { type: 'text-start', id: `a-${calls}` },
                        { type: 'text-delta', id: `a-${calls}`, delta: 'cut' },
                        { type: 'error', error: new AgentProviderStreamCutError() },
                        {
                          type: 'finish',
                          finishReason: { unified: 'error', raw: undefined },
                          usage: sdkUsage(10 * calls, calls),
                          providerMetadata: { openrouter: { usage: { cost: 0.01 * calls } } },
                        },
                      ]
                    : [
                        { type: 'text-start', id: 'ok' },
                        { type: 'text-delta', id: 'ok', delta: 'done' },
                        { type: 'text-end', id: 'ok' },
                        {
                          type: 'finish',
                          finishReason: { unified: 'stop', raw: undefined },
                          usage: sdkUsage(30, 3),
                          providerMetadata: { openrouter: { usage: { cost: 0.03 } } },
                        },
                      ];
                  return { stream: simulateReadableStream({ chunks } as never) };
                },
              }),
              { normalizeUsage: normalizePricedUsage },
            ),
          }),
        },
        prompt: () => ({
          instructions: 'test',
          sections: [],
          instructionTokens: { provenance: 'unavailable' },
          contextDecision: 'unavailable',
        }),
        tools: () => ({}),
        loop: { retry: { maxAttempts: 3, delayMs: () => 0 } },
        onStepSpend: (input) => {
          facts.push(spendOf(input));
        },
      });
      const result = await runtime.submit({
        conversationId: 'conv-retry3',
        idempotencyKey: 'retry3-1',
        context: {},
        parts: [{ type: 'text', text: 'go' }],
        metadata: {},
      }).result;
      await runtime.close();

      expect(result.reason).toBe('success');
      expect(facts.map((fact) => [fact.phase, fact.attempt])).toEqual([
        ['abandoned-attempt', 1],
        ['abandoned-attempt', 2],
        ['step', 3],
      ]);
      const summed = facts.reduce<AgentUsage | undefined>(
        (total, fact) => addUsage(total, fact.usage),
        undefined,
      );
      expect(summed).toEqual(result.run.usage);
      expect(result.run.usage?.inputTokens.value).toBe(60);
      expect(result.run.usage?.cost?.value).toBeCloseTo(0.06, 6);
    }

    // 2-step tool run (step 0 tool-call, step 1 final text).
    {
      let calls = 0;
      const facts: AgentStepSpend[] = [];
      const runtime = createAgentRuntime({
        protocol: defineAgentProtocol({
          context: z.strictObject({}),
          inputMetadata: z.strictObject({}),
        }),
        store: createMemoryAgentRuntimeStore(),
        models: {
          resolve: () => ({
            descriptor: {
              provider: 'gateway',
              modelId: 'two-step',
              contextWindow: 16_000,
              capabilities: ['tools'],
            },
            driver: fromAiSdkModel(
              new MockLanguageModelV4({
                doStream: async () => {
                  calls += 1;
                  const chunks: Record<string, unknown>[] =
                    calls === 1
                      ? [
                          {
                            type: 'tool-call',
                            toolCallId: 'c1',
                            toolName: 'ping',
                            input: '{}',
                          },
                          {
                            type: 'finish',
                            finishReason: { unified: 'tool-calls', raw: undefined },
                            usage: sdkUsage(100, 10),
                            providerMetadata: { openrouter: { usage: { cost: 0.1 } } },
                          },
                        ]
                      : [
                          { type: 'text-start', id: 't' },
                          { type: 'text-delta', id: 't', delta: 'done' },
                          { type: 'text-end', id: 't' },
                          {
                            type: 'finish',
                            finishReason: { unified: 'stop', raw: undefined },
                            usage: sdkUsage(200, 20),
                            providerMetadata: { openrouter: { usage: { cost: 0.2 } } },
                          },
                        ];
                  return { stream: simulateReadableStream({ chunks } as never) };
                },
              }),
              { normalizeUsage: normalizePricedUsage },
            ),
          }),
        },
        prompt: () => ({
          instructions: 'test',
          sections: [],
          instructionTokens: { provenance: 'unavailable' },
          contextDecision: 'unavailable',
        }),
        tools: () => ({
          ping: defineAgentTool({
            description: 'ping',
            input: z.strictObject({}),
            execute: async () => 'pong',
          }),
        }),
        loop: { maxSteps: 4 },
        onStepSpend: (input) => {
          facts.push(spendOf(input));
        },
      });
      const result = await runtime.submit({
        conversationId: 'conv-two-step',
        idempotencyKey: 'two-step-1',
        context: {},
        parts: [{ type: 'text', text: 'go' }],
        metadata: {},
      }).result;
      await runtime.close();

      expect(result.reason).toBe('success');
      expect(facts.map((fact) => [fact.phase, fact.step])).toEqual([
        ['step', 0],
        ['step', 1],
      ]);
      const summed = facts.reduce<AgentUsage | undefined>(
        (total, fact) => addUsage(total, fact.usage),
        undefined,
      );
      expect(summed).toEqual(result.run.usage);
      expect(result.run.usage?.inputTokens.value).toBe(300);
      expect(result.run.usage?.cost?.value).toBeCloseTo(0.3, 6);
    }
  });

  test('propagates finishReason, toolCallCount, costDetails, split timings with chunkIntervalsMs, and response identity to both onStepSpend and observe', async () => {
    const store = createMemoryAgentRuntimeStore();
    const facts: AgentStepSpend[] = [];
    const observed: AgentRunEvent[] = [];
    const ts = new Date('2026-11-28T10:15:00.000Z');
    const driver = createScriptedModelDriver({
      provider: 'openrouter',
      modelId: 'anthropic/claude-sonnet-4-6',
      steps: [
        [
          {
            type: 'response-metadata',
            id: 'gen-step-0',
            modelId: 'anthropic/claude-sonnet-4-6',
            timestamp: ts,
          },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'ping', input: '{}' },
          {
            type: 'finish',
            finishReason: 'tool-calls',
            rawFinishReason: 'tool_use',
            usage: {
              inputTokens: { value: 50, provenance: 'provider-reported' },
              outputTokens: { value: 12, provenance: 'provider-reported' },
              cost: { value: 0.004, currency: 'USD', provenance: 'provider-reported' },
            },
            costDetails: { promptCostUsd: 0.0015, outputCostUsd: 0.0025, isByok: false },
            responseProvider: 'Anthropic',
          },
        ],
        [
          {
            type: 'response-metadata',
            id: 'gen-step-1',
            modelId: 'anthropic/claude-sonnet-4-6',
            timestamp: ts,
          },
          { type: 'text-delta', id: 't1', delta: 'Hel' },
          { type: 'text-delta', id: 't1', delta: 'lo ' },
          { type: 'text-delta', id: 't1', delta: 'world' },
          {
            type: 'finish',
            finishReason: 'stop',
            rawFinishReason: 'end_turn',
            usage: {
              inputTokens: { value: 80, provenance: 'provider-reported' },
              outputTokens: { value: 9, provenance: 'provider-reported' },
              cost: { value: 0.006, currency: 'USD', provenance: 'provider-reported' },
            },
            costDetails: { promptCostUsd: 0.002, outputCostUsd: 0.004, isByok: true },
            responseProvider: 'Anthropic',
          },
        ],
      ],
    });
    const observe = createAgentObservability({
      write: (event) => {
        observed.push(event);
      },
    });
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store,
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'openrouter',
            modelId: 'anthropic/claude-sonnet-4-6',
            contextWindow: 200_000,
            capabilities: ['tools'],
          },
          driver,
        }),
      },
      prompt: () => ({
        instructions: 'test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({
        ping: defineAgentTool({
          description: 'ping',
          input: z.object({}),
          execute: async () => {
            await Bun.sleep(10);
            return 'pong';
          },
        }),
      }),
      observe,
      onStepSpend: (input) => {
        if (input.phase !== 'step') return;
        facts.push(
          AgentStepSpendSchema.parse({
            conversationId: input.conversationId,
            runId: input.runId,
            step: input.step,
            attempt: input.attempt,
            usage: input.usage,
            phase: input.phase,
            model: input.model,
            provider: input.provider,
            response: input.response,
            ...(input.finishReason !== undefined && { finishReason: input.finishReason }),
            ...(input.rawFinishReason !== undefined && {
              rawFinishReason: input.rawFinishReason,
            }),
            ...(input.toolCallCount !== undefined && { toolCallCount: input.toolCallCount }),
            ...(input.costDetails !== undefined && { costDetails: input.costDetails }),
            ...(input.timings !== undefined && { timings: input.timings }),
          }),
        );
      },
    });

    const result = await runtime.submit({
      conversationId: 'conv-telemetry',
      idempotencyKey: 'tel-1',
      context: {},
      parts: [{ type: 'text', text: 'go' }],
      metadata: {},
    }).result;
    await observe.flush();
    await runtime.close();

    expect(result.reason).toBe('success');
    expect(facts).toHaveLength(2);
    const step0 = facts[0];
    const step1 = facts[1];
    expect(step0?.phase).toBe('step');
    expect(step1?.phase).toBe('step');
    if (step0?.phase === 'step' && step1?.phase === 'step') {
      expect(step0.finishReason).toBe('tool-calls');
      expect(step0.rawFinishReason).toBe('tool_use');
      expect(step0.toolCallCount).toBe(1);
      expect(step0.costDetails).toEqual({
        promptCostUsd: 0.0015,
        outputCostUsd: 0.0025,
        isByok: false,
      });
      expect(step0.response).toEqual({
        id: 'gen-step-0',
        provider: 'Anthropic',
        modelId: 'anthropic/claude-sonnet-4-6',
        timestamp: ts.toISOString(),
      });
      expect(step0.timings?.toolExecutionMs).toBeGreaterThanOrEqual(5);
      // Step 0 had no multi-chunk text/reasoning/tool-input deltas -> chunkIntervalsMs omitted.
      expect(step0.timings?.chunkIntervalsMs).toBeUndefined();

      expect(step1.finishReason).toBe('stop');
      expect(step1.rawFinishReason).toBe('end_turn');
      expect(step1.toolCallCount).toBe(0);
      expect(step1.costDetails).toEqual({
        promptCostUsd: 0.002,
        outputCostUsd: 0.004,
        isByok: true,
      });
      expect(step1.timings?.ttftMs).toBeGreaterThanOrEqual(0);
      expect(step1.timings?.responseTimeMs).toBeGreaterThanOrEqual(0);
      expect(step1.timings?.stepTimeMs).toBeGreaterThanOrEqual(0);
      // Step 1 streamed 3 text-deltas -> chunkIntervalsMs computed with 2 intervals.
      expect(step1.timings?.chunkIntervalsMs).toBeDefined();
      expect(step1.timings?.chunkIntervalsMs?.min).toBeGreaterThanOrEqual(0);
      expect(step1.timings?.chunkIntervalsMs?.max).toBeGreaterThanOrEqual(
        step1.timings?.chunkIntervalsMs?.min ?? 0,
      );
    }

    const stepFinished = observed.filter((event) => event.type === 'step-finished');
    expect(stepFinished).toHaveLength(2);
    expect(stepFinished[0]).toMatchObject({
      finishReason: 'tool-calls',
      rawFinishReason: 'tool_use',
      toolCallCount: 1,
      costDetails: { promptCostUsd: 0.0015, outputCostUsd: 0.0025, isByok: false },
      response: {
        id: 'gen-step-0',
        provider: 'Anthropic',
        modelId: 'anthropic/claude-sonnet-4-6',
        timestamp: ts.toISOString(),
      },
    });
    expect(stepFinished[1]?.timings?.chunkIntervalsMs).toBeDefined();
  });
});
