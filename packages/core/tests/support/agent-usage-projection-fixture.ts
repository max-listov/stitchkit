import { randomBytes } from 'node:crypto';
import { simulateReadableStream, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import type { createBunSqliteAgentRuntimeStore } from '../../src/agent-runtime/sqlite-bun';
import {
  type AgentUsage,
  createAgentRuntime,
  createModelInvocationLedger,
  defineAgentProtocol,
  defineModelRegistry,
} from '../../src/entrypoints/agent-runtime';

const CostMetadataSchema = z.object({
  billing: z.object({
    cost: z.number().nonnegative(),
    currency: z.string().length(3).optional(),
  }),
});

export const reported = (value: number) =>
  ({ value, provenance: 'provider-reported' }) as const;

export function sdkUsage(input: {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
}) {
  const inputTotal = input.input;
  const outputTotal = input.output;
  return {
    inputTokens: {
      total: inputTotal,
      noCache:
        inputTotal !== undefined
          ? inputTotal - (input.cacheRead ?? 0) - (input.cacheWrite ?? 0)
          : undefined,
      cacheRead: input.cacheRead,
      cacheWrite: input.cacheWrite,
    },
    outputTokens: {
      total: outputTotal,
      text: outputTotal !== undefined ? outputTotal - (input.reasoning ?? 0) : undefined,
      reasoning: input.reasoning,
    },
  };
}

export function normalizePricedUsage(input: {
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
    outputTokenDetails?: { reasoningTokens?: number };
  };
  providerMetadata?: unknown;
}): AgentUsage {
  const token = (value: number | undefined) =>
    value === undefined ? ({ provenance: 'unavailable' } as const) : reported(value);
  const meta = CostMetadataSchema.safeParse(input.providerMetadata);
  return {
    inputTokens: token(input.usage.inputTokens),
    outputTokens: token(input.usage.outputTokens),
    reasoningTokens: token(input.usage.outputTokenDetails?.reasoningTokens),
    cacheReadTokens: token(input.usage.inputTokenDetails?.cacheReadTokens),
    cacheWriteTokens: token(input.usage.inputTokenDetails?.cacheWriteTokens),
    ...(meta.success && {
      cost: {
        value: meta.data.billing.cost,
        ...(meta.data.billing.currency && { currency: meta.data.billing.currency }),
        provenance: 'provider-reported' as const,
      },
    }),
  };
}

export interface TurnSpec {
  text?: string;
  usage: ReturnType<typeof sdkUsage>;
  cost?: { value: number; currency?: string };
}

export function scriptedModel(turns: readonly TurnSpec[]) {
  let index = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const turn = turns[index++];
      if (!turn) throw new Error(`Unexpected model call ${index}`);
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'response-metadata', id: `resp-${index}`, modelId: 'priced-model' },
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: turn.text ?? `reply-${index}` },
            { type: 'text-end', id: 't' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: undefined },
              usage: turn.usage,
              ...(turn.cost && {
                providerMetadata: {
                  billing: {
                    cost: turn.cost.value,
                    ...(turn.cost.currency && { currency: turn.cost.currency }),
                  },
                },
              }),
            },
          ],
        }),
      };
    },
  });
}

export function createUsageTestRuntime(input: {
  sqlite: ReturnType<typeof createBunSqliteAgentRuntimeStore>;
  model: MockLanguageModelV4;
  extraModels?: Record<string, MockLanguageModelV4>;
  withPriceNormalizer?: boolean;
  withInvocations?: boolean;
  contextDecision?: () => 'fits' | 'oversized' | 'unavailable';
  compactUsage?: AgentUsage;
  retryMaxAttempts?: number;
}) {
  const descriptor = (modelId: string) => ({
    provider: modelId,
    modelId,
    contextWindow: 100_000,
    capabilities: [],
  });
  const providers: Record<
    string,
    {
      create: () => MockLanguageModelV4;
      normalizeUsage?: typeof normalizePricedUsage;
    }
  > = {
    'priced-model': {
      create: () => input.model,
      ...(input.withPriceNormalizer !== false && { normalizeUsage: normalizePricedUsage }),
    },
  };
  const modelEntries: Record<string, ReturnType<typeof descriptor>> = {
    priced: descriptor('priced-model'),
  };
  for (const [key, extraModel] of Object.entries(input.extraModels ?? {})) {
    const modelId = `${key}-model`;
    modelEntries[key] = descriptor(modelId);
    providers[modelId] = {
      create: () => extraModel,
      ...(input.withPriceNormalizer !== false && { normalizeUsage: normalizePricedUsage }),
    };
  }
  const models = defineModelRegistry({ models: modelEntries, providers });
  const ledger = input.withInvocations
    ? createModelInvocationLedger({
        store: input.sqlite.store,
        models,
        payloadKey: randomBytes(32),
        authorize: () => ({ subject: 'tester' }),
      })
    : undefined;
  const runtime = createAgentRuntime({
    store: input.sqlite.store,
    protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
    models: { resolve: () => models.resolve('priced') },
    tools: () => ({
      ping: tool({
        description: 'ping',
        inputSchema: z.object({}),
        execute: async () => 'pong',
      }),
    }),
    prompt: () => ({
      instructions: 'test',
      sections: [],
      instructionTokens: { provenance: 'unavailable' },
      contextDecision: input.contextDecision ? input.contextDecision() : 'unavailable',
    }),
    ...(input.compactUsage && {
      history: {
        compact: async ({ conversationId, store }) => ({
          outcome: 'applied' as const,
          attempts: 1,
          snapshot: await store.loadSnapshot(conversationId),
          usage: input.compactUsage,
        }),
      },
    }),
    loop: {
      maxSteps: 5,
      ...(input.retryMaxAttempts && {
        retry: { maxAttempts: input.retryMaxAttempts, delayMs: () => 0 },
      }),
    },
    ...(ledger && {
      invocations: {
        ledger,
        trace: () => ({ operationId: 'op', project: 'proj', purpose: 'usage-test' }),
      },
    }),
  });
  const submit = (conversationId: string, idempotencyKey: string, text = idempotencyKey) =>
    runtime.submit({
      conversationId,
      idempotencyKey,
      context: {},
      parts: [{ type: 'text', text }],
    }).result;
  return { runtime, ledger, models, submit };
}
