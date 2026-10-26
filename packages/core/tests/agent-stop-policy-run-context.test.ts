import { expect, test } from 'bun:test';
import { simulateReadableStream, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../src/entrypoints/agent-runtime';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

const protocol = defineAgentProtocol({
  context: z.object({ tenant: z.string() }),
  inputMetadata: z.object({}),
});

type StreamPart =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<
    infer Part
  >
    ? Part
    : never;

const answer: StreamPart[] = [
  { type: 'text-start', id: 'text-1' },
  { type: 'text-delta', id: 'text-1', delta: 'done' },
  { type: 'text-end', id: 'text-1' },
  { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
];
const toolCall: StreamPart[] = [
  {
    type: 'tool-call',
    toolCallId: 'call-1',
    toolName: 'lookup',
    input: '{"query":"value"}',
  },
  { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
];

/** One tool call, then — once its result is in the prompt — a plain answer. */
const model = new MockLanguageModelV4({
  doStream: async ({ prompt }) => ({
    stream: simulateReadableStream({
      chunks: prompt.some((message) => message.role === 'tool') ? answer : toolCall,
    }),
  }),
});

test('a stop policy sees the run it decides for, the same run prepareStep sees', async () => {
  const prepared = new Map<string, string>();
  const decided: { tenant: string; runId: string; conversationId: string; signal: boolean }[] =
    [];
  const runtime = createAgentRuntime({
    protocol,
    store: createMemoryAgentRuntimeStore(),
    models: {
      resolve: () => ({
        descriptor: {
          provider: 'test',
          modelId: 'test-model',
          contextWindow: 1_000,
          capabilities: [],
        },
        model,
      }),
    },
    prompt: () => ({
      instructions: 'test',
      sections: [],
      instructionTokens: { provenance: 'unavailable' },
      contextDecision: 'unavailable',
    }),
    tools: () => ({
      lookup: tool({
        inputSchema: z.object({ query: z.string() }),
        execute: ({ query }) => ({ answer: query }),
      }),
    }),
    loop: {
      prepareStep: ({ context, run }) => {
        prepared.set(context.tenant, run.id);
        return undefined;
      },
      stopPolicies: [
        {
          name: 'tenant-a-stops',
          // Typed by the runtime's own context: `context.tenant` needs no cast.
          when: ({ steps, context, run, signal }) => {
            decided.push({
              tenant: context.tenant,
              runId: run.id,
              conversationId: run.conversationId,
              signal: signal instanceof AbortSignal,
            });
            return steps.length > 0 && context.tenant === 'a';
          },
        },
      ],
    },
  });
  const submit = (tenant: string) =>
    runtime.submit({
      conversationId: `conversation-${tenant}`,
      idempotencyKey: `input-${tenant}`,
      context: { tenant },
      parts: [{ type: 'text', text: 'hello' }],
      metadata: {},
    }).result;

  const [a, b] = await Promise.all([submit('a'), submit('b')]);
  expect(a.reason).toBe('policy_stop');
  expect(a.policyName).toBe('tenant-a-stops');
  expect(b.reason).not.toBe('policy_stop');

  expect(decided.length).toBeGreaterThanOrEqual(2);
  for (const decision of decided) {
    expect(decision.runId).toBe(prepared.get(decision.tenant) ?? '');
    expect(decision.conversationId).toBe(`conversation-${decision.tenant}`);
    expect(decision.signal).toBe(true);
  }
  expect(new Set(decided.map((decision) => decision.tenant))).toEqual(new Set(['a', 'b']));
  await runtime.close();
});
