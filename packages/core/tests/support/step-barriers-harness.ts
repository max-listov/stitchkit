/**
 * A runtime over a scripted model, for the step-barrier tests: each round is
 * one provider response, the tools and the barriers are the test's own, and
 * every published event is kept.
 */
import { jsonSchema, simulateReadableStream, type ToolSet } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  type AgentRuntimeConfig,
  type AgentRuntimeEvent,
  type AgentSnapshot,
  type AgentStepBarriers,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../../src/entrypoints/agent-runtime';

export const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
export const finish = (unified: 'tool-calls' | 'stop') => ({
  type: 'finish' as const,
  finishReason: { unified, raw: undefined },
  usage,
});
export type StreamPart =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<
    infer T
  >
    ? T
    : never;
export const round = (chunks: StreamPart[]) => ({
  stream: simulateReadableStream<StreamPart>({ chunks }),
});
export const call = (toolCallId: string, toolName: string, input: object = {}) => ({
  type: 'tool-call' as const,
  toolCallId,
  toolName,
  input: JSON.stringify(input),
});
export const text = (delta: string) => [
  { type: 'text-start' as const, id: 't' },
  { type: 'text-delta' as const, id: 't', delta },
  { type: 'text-end' as const, id: 't' },
];
export const answer = (said = 'final') => round([...text(said), finish('stop')]);
export const noInput = jsonSchema<Record<string, string>>({ type: 'object' });
export const idOf = (input: unknown) => z.object({ id: z.string() }).parse(input).id;

type Loop = NonNullable<AgentRuntimeConfig<Record<string, never>, ToolSet>['loop']>;

export function harness(
  rounds: ReturnType<typeof round>[],
  tools: ToolSet,
  stepBarriers: AgentStepBarriers,
  loop: Omit<Loop, 'stepBarriers'> = {},
) {
  const events: AgentRuntimeEvent[] = [];
  const store = createMemoryAgentRuntimeStore();
  // One model across runs: a run answered after an approval reads the next round.
  const model = new MockLanguageModelV4({ doStream: rounds });
  const runtime = createAgentRuntime({
    protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
    store,
    models: {
      resolve: () => ({
        descriptor: {
          provider: 't',
          modelId: 'm',
          contextWindow: 1_000,
          capabilities: ['tools'],
        },
        model,
      }),
    },
    prompt: () => ({
      instructions: 'test',
      sections: [],
      instructionTokens: { provenance: 'unavailable' as const },
      contextDecision: 'unavailable' as const,
    }),
    tools: () => tools,
    publish: (event) => void events.push(event),
    loop: { maxSteps: 5, stepBarriers, ...loop },
  });
  const say = (idempotencyKey: string) =>
    runtime.submit({
      conversationId: 'c',
      idempotencyKey,
      context: {},
      parts: [{ type: 'text', text: 'go' }],
      metadata: {},
    }).result;
  const answerApprovals = (idempotencyKey: string, approvalIds: string[], approved: boolean) =>
    runtime.submit({
      conversationId: 'c',
      idempotencyKey,
      context: {},
      role: 'tool',
      parts: approvalIds.map((approvalId) => ({
        type: 'tool-approval-response' as const,
        approvalId,
        approved,
      })),
      metadata: {},
    }).result;
  return { runtime, store, events, say, answerApprovals };
}

export const partsOf = (snapshot: AgentSnapshot) =>
  snapshot.messages.flatMap((message) => message.parts);
export const approvalIds = (snapshot: AgentSnapshot) =>
  partsOf(snapshot).flatMap((part) =>
    part.type === 'tool-approval-request' ? [part.approvalId] : [],
  );
export const results = (snapshot: AgentSnapshot) =>
  partsOf(snapshot).flatMap((part) =>
    part.type === 'tool-result' ? [`${part.callId}:${part.outcome}`] : [],
  );
