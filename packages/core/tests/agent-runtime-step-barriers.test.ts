import { describe, expect, test } from 'bun:test';
import { jsonSchema, simulateReadableStream, type ToolSet, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  deferredToolCatalog,
  registerDeferredToolCatalog,
} from '../src/agent-runtime/deferred-tools-internal';
import { applyStepBarriers } from '../src/agent-runtime/run-step-barriers';
import {
  type AgentRuntimeEvent,
  type AgentStepBarriers,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  createToolDependencyResolver,
  defineAgentProtocol,
} from '../src/entrypoints/agent-runtime';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const finish = (unified: 'tool-calls' | 'stop') => ({
  type: 'finish' as const,
  finishReason: { unified, raw: undefined },
  usage,
});

type StreamPart =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<
    infer T
  >
    ? T
    : never;
const round = (chunks: StreamPart[]) => ({
  stream: simulateReadableStream<StreamPart>({ chunks }),
});
const call = (toolCallId: string, toolName: string, input: object = {}) => ({
  type: 'tool-call' as const,
  toolCallId,
  toolName,
  input: JSON.stringify(input),
});
const text = (delta: string) => [
  { type: 'text-start' as const, id: 't' },
  { type: 'text-delta' as const, id: 't', delta },
  { type: 'text-end' as const, id: 't' },
];
const answer = () => round([...text('final'), finish('stop')]);

async function run(
  rounds: ReturnType<typeof round>[],
  tools: ToolSet,
  stepBarriers: AgentStepBarriers,
) {
  const events: AgentRuntimeEvent[] = [];
  const store = createMemoryAgentRuntimeStore();
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
        model: new MockLanguageModelV4({ doStream: rounds }),
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
    loop: { maxSteps: 3, stepBarriers },
  });
  const result = await runtime.submit({
    conversationId: 'c',
    idempotencyKey: 'k',
    context: {},
    parts: [{ type: 'text', text: 'go' }],
    metadata: {},
  }).result;
  const snapshot = await store.loadSnapshot('c');
  await runtime.close();
  return { events, result, snapshot };
}

const noInput = jsonSchema<Record<string, string>>({ type: 'object' });

describe('step barriers', () => {
  test('a step making more calls than allowed has the extra one refused to the model', async () => {
    const ran: string[] = [];
    const counted = tool({
      inputSchema: noInput,
      execute: async (_input, { toolCallId }) => {
        ran.push(toolCallId);
        return 'ok';
      },
    });
    const { snapshot } = await run(
      [round([call('a', 'counted'), call('b', 'counted'), finish('tool-calls')]), answer()],
      { counted },
      { maxToolCallsPerStep: 1 },
    );
    expect(ran).toEqual(['a']);
    const results = snapshot.messages.flatMap((message) =>
      message.parts.flatMap((part) => (part.type === 'tool-result' ? [part] : [])),
    );
    expect(results.find((part) => part.callId === 'b')).toMatchObject({
      outcome: 'error',
      output: { code: 'STEP_TOOL_CALL_LIMIT' },
    });
  });

  test("a read of an entity waits for the step's earlier write of it", async () => {
    const order: string[] = [];
    const write = tool({
      inputSchema: noInput,
      execute: async () => {
        order.push('write-start');
        await Bun.sleep(30);
        order.push('write-end');
        return 'written';
      },
    });
    const read = tool({
      inputSchema: noInput,
      execute: async (input) => {
        order.push(`read:${input.id}`);
        return 'value';
      },
    });
    await run(
      [
        round([
          call('w', 'write', { id: 'e1' }),
          call('r', 'read', { id: 'e1' }),
          call('o', 'read', { id: 'e2' }),
          finish('tool-calls'),
        ]),
        answer(),
      ],
      { write, read },
      {
        toolDependencies: createToolDependencyResolver({
          effects: { write: 'write', read: 'read' },
          entityOf: (_name, input) => z.object({ id: z.string() }).parse(input).id,
        }),
      },
    );
    // e1 waits for its write; e2 has none to wait for and is not held back.
    expect(order.indexOf('read:e1')).toBeGreaterThan(order.indexOf('write-end'));
    expect(order.indexOf('read:e2')).toBeLessThan(order.indexOf('write-end'));
  });

  test('after-tools: a step whose call failed shows none of its text; a clean step shows it after the call', async () => {
    const fails = tool({
      inputSchema: noInput,
      execute: async (): Promise<string> => {
        throw new Error('broken');
      },
    });
    const works = tool({ inputSchema: noInput, execute: async () => 'fine' });
    const failed = await run(
      [round([...text('I did it'), call('x', 'fails'), finish('tool-calls')]), answer()],
      { fails },
      { stepText: 'after-tools' },
    );
    const textOf = (messages: typeof failed.snapshot.messages) =>
      messages
        .flatMap((message) =>
          message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
        )
        .join('|');
    expect(textOf(failed.snapshot.messages)).not.toContain('I did it');
    expect(
      failed.events.some(
        (event) => event.type === 'assistant-delta' && event.textDelta === 'I did it',
      ),
    ).toBe(false);

    const clean = await run(
      [round([...text('Done:'), call('y', 'works'), finish('tool-calls')]), answer()],
      { works },
      { stepText: 'after-tools' },
    );
    expect(textOf(clean.snapshot.messages)).toContain('Done:');
    const delta = clean.events.findIndex(
      (event) => event.type === 'assistant-delta' && event.textDelta === 'Done:',
    );
    const settled = clean.events.findIndex(
      (event) => event.type === 'tool-status' && event.status === 'completed',
    );
    expect(delta).toBeGreaterThan(settled);
  });

  test('reasoning past its bound stops the run as policy_stop', async () => {
    const { result } = await run(
      [
        round([
          { type: 'reasoning-start' as const, id: 'r' },
          { type: 'reasoning-delta' as const, id: 'r', delta: 'x'.repeat(50) },
          { type: 'reasoning-end' as const, id: 'r' },
          ...text('answer'),
          finish('stop'),
        ]),
      ],
      {},
      { maxReasoningCharsPerStep: 10 },
    );
    expect(result.reason).toBe('policy_stop');
  });

  test('wrapping keeps a deferred tool catalog, and a bound no step could meet is refused at creation', () => {
    const search = tool({ inputSchema: noInput, execute: async () => 'found' });
    const tools: ToolSet = { search };
    registerDeferredToolCatalog(tools, 'search', new Set(['hidden']));
    const wrapped = applyStepBarriers(tools, undefined, { maxToolCallsPerStep: 2 }).tools;
    expect(wrapped.search).not.toBe(search);
    expect(deferredToolCatalog(wrapped, 'search')).toEqual(new Set(['hidden']));
    // A misspelt mode from configuration is refused, not read as `immediate`.
    const misspelt: AgentStepBarriers = JSON.parse('{"stepText":"after-tool"}');
    for (const bad of [
      { maxToolCallsPerStep: 0 },
      { maxReasoningCharsPerStep: Number.NaN },
      misspelt,
    ]) {
      expect(() =>
        createAgentRuntime({
          protocol: defineAgentProtocol({
            context: z.object({}),
            inputMetadata: z.object({}),
          }),
          store: createMemoryAgentRuntimeStore(),
          models: {
            resolve: () => {
              throw new Error('no run starts');
            },
          },
          prompt: () => ({
            instructions: '',
            sections: [],
            instructionTokens: { provenance: 'unavailable' as const },
            contextDecision: 'unavailable' as const,
          }),
          tools: () => ({}),
          loop: { stepBarriers: bad },
        }),
      ).toThrow(RangeError);
    }
  });
});
