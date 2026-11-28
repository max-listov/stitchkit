import { describe, expect, test } from 'bun:test';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  deferredToolCatalog,
  registerDeferredToolCatalog,
} from '../src/agent-runtime/deferred-tools-internal';
import { createStepCallScheduler } from '../src/agent-runtime/run-step-barriers';
import {
  type AgentRuntimeEvent,
  type AgentStepBarriers,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  createToolDependencyResolver,
  defineAgentProtocol,
} from '../src/entrypoints/agent-runtime';
import { fromAiSdkModel } from '../src/entrypoints/agent-runtime/ai-sdk';
import { createScriptedModelDriver } from '../src/entrypoints/agent-runtime/testing';
import { AgentToolError, type AgentToolSet, defineAgentTool } from '../src/entrypoints/tools';

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
  tools: AgentToolSet,
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
        driver: fromAiSdkModel(new MockLanguageModelV4({ doStream: rounds })),
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

const noInput = z.record(z.string(), z.string());

describe('step barriers', () => {
  test('a step making more calls than allowed has the extra one refused to the model', async () => {
    const ran: string[] = [];
    const counted = defineAgentTool({
      input: noInput,
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
    const write = defineAgentTool({
      input: noInput,
      execute: async () => {
        order.push('write-start');
        await Bun.sleep(30);
        order.push('write-end');
        return 'written';
      },
    });
    const read = defineAgentTool({
      input: noInput,
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
    const fails = defineAgentTool({
      input: noInput,
      execute: async (): Promise<string> => {
        throw new Error('broken');
      },
    });
    const works = defineAgentTool({ input: noInput, execute: async () => 'fine' });
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
    const search = defineAgentTool({ input: noInput, execute: async () => 'found' });
    const tools: AgentToolSet = { search };
    registerDeferredToolCatalog(tools, 'search', new Set(['hidden']));
    const scheduler = createStepCallScheduler({ maxToolCallsPerStep: 2 });
    expect(scheduler.enter('search', {}).refused).toBe(false);
    expect(scheduler.enter('search', {}).refused).toBe(false);
    expect(scheduler.enter('search', {}).refused).toBe(true);
    expect(deferredToolCatalog(tools, 'search')).toEqual(new Set(['hidden']));
    // A misspelt mode from configuration is refused, not read as `immediate`.
    const misspelt: AgentStepBarriers = JSON.parse('{"stepText":"after-tool"}');
    const badReasoningAction: AgentStepBarriers = JSON.parse('{"onMaxReasoningChars":"drop"}');
    const badInterruptMode: AgentStepBarriers = JSON.parse('{"stepTextOnInterrupt":"keep"}');
    for (const bad of [
      { maxToolCallsPerStep: 0 },
      { maxReasoningCharsPerStep: Number.NaN },
      misspelt,
      badReasoningAction,
      badInterruptMode,
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

  test('onMaxReasoningChars: finish-length cuts step cleanly and allows protocol.acceptTerminal recovery', async () => {
    const store = createMemoryAgentRuntimeStore();
    const driver = createScriptedModelDriver({
      provider: 'test',
      modelId: 'reasoning-model',
      steps: [
        [
          { type: 'reasoning-start', id: 'r1' },
          { type: 'reasoning-delta', id: 'r1', delta: 'x'.repeat(30) },
          { type: 'text-delta', id: 't1', delta: 'never reached' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: {
              inputTokens: { value: 10, provenance: 'provider-reported' },
              outputTokens: { value: 30, provenance: 'provider-reported' },
            },
          },
        ],
        [
          { type: 'text-delta', id: 't2', delta: 'Concise recovered answer.' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: {
              inputTokens: { value: 20, provenance: 'provider-reported' },
              outputTokens: { value: 6, provenance: 'provider-reported' },
            },
          },
        ],
      ],
    });
    const observedFinishReasons: string[] = [];
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({
        context: z.object({}),
        inputMetadata: z.object({}),
        terminalAcceptance: ({ steps, continuations }) => {
          observedFinishReasons.push(steps?.at(-1)?.finishReason ?? 'none');
          if (steps?.at(-1)?.finishReason === 'length' && (continuations ?? 0) === 0) {
            return {
              action: 'continue',
              message: {
                role: 'user',
                content: 'Please answer concisely without long reasoning.',
              },
            };
          }
          return { action: 'accept' };
        },
      }),
      store,
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'test',
            modelId: 'reasoning-model',
            contextWindow: 10_000,
            capabilities: ['reasoning'],
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
      tools: () => ({}),
      loop: {
        stepBarriers: {
          maxReasoningCharsPerStep: 10,
          onMaxReasoningChars: 'finish-length',
        },
      },
    });
    const res = await runtime.submit({
      conversationId: 'c-reason-recover',
      idempotencyKey: 'rr-1',
      context: {},
      parts: [{ type: 'text', text: 'solve' }],
      metadata: {},
    }).result;
    await runtime.close();

    expect(res.reason).toBe('success');
    expect(observedFinishReasons).toEqual(['length', 'stop']);
    expect(res.message.parts.find((p) => p.type === 'text')).toEqual({
      type: 'text',
      text: 'Concise recovered answer.',
    });
  });

  test('onPredecessorFailure: refuse blocks dependent calls after invalid input, beforeStepToolCalls refusal, or isToolResultFailure payload without poisoning earlier valid calls', async () => {
    const executed: string[] = [];
    const readDoc = defineAgentTool({
      input: z.object({ id: z.string() }),
      execute: async ({ id }, { toolCallId }) => {
        executed.push(`read:${toolCallId}:${id}`);
        return { id, ok: true };
      },
    });
    const writeDoc = defineAgentTool({
      input: z.object({ id: z.string(), count: z.number().int().positive() }),
      execute: async ({ id, count }, { toolCallId }) => {
        executed.push(`write:${toolCallId}:${id}`);
        if (count === 999) return { error: 'soft business failure' };
        return { id, saved: count };
      },
    });
    const toolDependencies = createToolDependencyResolver({
      effects: { readDoc: 'read', writeDoc: 'write' },
      entityOf: (_toolName, inp) =>
        typeof inp === 'object' && inp !== null && 'id' in inp && typeof inp.id === 'string'
          ? `doc:${inp.id}`
          : undefined,
    });

    const driver = createScriptedModelDriver({
      provider: 'test',
      modelId: 'm',
      steps: [
        [
          // Doc A: valid read BEFORE invalid write -> MUST execute (not poisoned by later invalid write!)
          {
            type: 'tool-call',
            toolCallId: 'a-read-before',
            toolName: 'readDoc',
            input: '{"id":"A"}',
          },
          // Doc A: invalid input (count: -1 fails Zod positive())
          {
            type: 'tool-call',
            toolCallId: 'a-write-invalid',
            toolName: 'writeDoc',
            input: '{"id":"A","count":-1}',
          },
          // Doc A: read AFTER invalid write -> MUST be refused!
          {
            type: 'tool-call',
            toolCallId: 'a-read-after',
            toolName: 'readDoc',
            input: '{"id":"A"}',
          },
          // Doc B: write refused by beforeStepToolCalls -> subsequent read on B MUST be refused!
          {
            type: 'tool-call',
            toolCallId: 'b-write-batch-refused',
            toolName: 'writeDoc',
            input: '{"id":"B","count":1}',
          },
          {
            type: 'tool-call',
            toolCallId: 'b-read-after',
            toolName: 'readDoc',
            input: '{"id":"B"}',
          },
          // Doc C: write returns `{ error: ... }` (`isToolResultFailure`) -> subsequent read on C MUST be refused!
          {
            type: 'tool-call',
            toolCallId: 'c-write-soft-fail',
            toolName: 'writeDoc',
            input: '{"id":"C","count":999}',
          },
          {
            type: 'tool-call',
            toolCallId: 'c-read-after',
            toolName: 'readDoc',
            input: '{"id":"C"}',
          },
          {
            type: 'finish',
            finishReason: 'tool-calls',
            usage: {
              inputTokens: { value: 10, provenance: 'provider-reported' },
              outputTokens: { value: 10, provenance: 'provider-reported' },
            },
          },
        ],
        [
          { type: 'text-delta', id: 't', delta: 'done' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: {
              inputTokens: { value: 20, provenance: 'provider-reported' },
              outputTokens: { value: 5, provenance: 'provider-reported' },
            },
          },
        ],
      ],
    });
    const store = createMemoryAgentRuntimeStore();
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store,
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'test',
            modelId: 'm',
            contextWindow: 10_000,
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
      tools: () => ({ readDoc, writeDoc }),
      loop: {
        beforeStepToolCalls: ({ calls }) => {
          const refuse = new Map<string, AgentToolError>();
          for (const entry of calls) {
            if (entry.toolCallId === 'b-write-batch-refused') {
              refuse.set(
                entry.toolCallId,
                new AgentToolError({ code: 'BATCH_DENIED', message: 'Blocked by policy' }),
              );
            }
          }
          return refuse.size > 0 ? { refuse } : undefined;
        },
        stepBarriers: {
          toolDependencies,
          onPredecessorFailure: 'refuse',
        },
      },
    });
    const res = await runtime.submit({
      conversationId: 'c-pred-parity',
      idempotencyKey: 'pp-1',
      context: {},
      parts: [{ type: 'text', text: 'run' }],
      metadata: {},
    }).result;
    await runtime.close();

    expect(res.reason).toBe('success');
    expect(executed).toEqual(['read:a-read-before:A', 'write:c-write-soft-fail:C']);
    const results = res.message.parts.filter((p) => p.type === 'tool-result');
    for (const callId of ['a-read-after', 'b-read-after', 'c-read-after']) {
      expect(results.find((r) => r.callId === callId)).toMatchObject({
        outcome: 'error',
        output: { code: 'STEP_PREDECESSOR_FAILED' },
      });
    }
  });

  test('stepText: after-tools holds on isToolResultFailure and tool-approval-request, applies filterStepText, and respects stepTextOnInterrupt', async () => {
    // 1. Soft failure `{ error: ... }` suppresses held step text.
    const softFailTool = defineAgentTool({
      input: z.object({}),
      execute: async () => ({ error: 'insufficient balance' }),
    });
    const softRes = await run(
      [
        round([...text('All done!'), call('c1', 'softFailTool'), finish('tool-calls')]),
        answer(),
      ],
      { softFailTool },
      { stepText: 'after-tools' },
    );
    const softTexts = softRes.snapshot.messages
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.parts.filter((p) => p.type === 'text').map((p) => p.text));
    expect(softTexts.join('')).not.toContain('All done!');
    expect(softTexts.join('')).toContain('final');

    // 2. tool-approval-request suppresses held step text; filterStepText rewrites clean held text.
    const gatedTool = defineAgentTool({
      input: z.object({}),
      needsApproval: true,
      execute: async () => ({ ok: true }),
    });
    const approvalRes = await run(
      [round([...text('Already completed!'), call('c1', 'gatedTool'), finish('tool-calls')])],
      { gatedTool },
      { stepText: 'after-tools' },
    );
    const approvalTexts = approvalRes.snapshot.messages
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.parts.filter((p) => p.type === 'text').map((p) => p.text));
    expect(approvalTexts.join('')).not.toContain('Already completed!');
    expect(
      approvalRes.result.message.parts.some((p) => p.type === 'tool-approval-request'),
    ).toBe(true);

    const okTool = defineAgentTool({
      input: z.object({}),
      execute: async () => ({ ok: true }),
    });
    const filtered = await run(
      [
        round([...text('  draft text  '), call('c1', 'okTool'), finish('tool-calls')]),
        answer(),
      ],
      { okTool },
      {
        stepText: 'after-tools',
        filterStepText: (raw, ctx) => (ctx.step === 0 ? raw.trim().toUpperCase() : raw),
      },
    );
    const filteredTexts = filtered.snapshot.messages
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.parts.filter((p) => p.type === 'text').map((p) => p.text));
    expect(filteredTexts.join('')).toContain('DRAFT TEXT');

    // 3. stepTextOnInterrupt: 'flush' vs default 'drop' when interrupted mid-step.
    for (const mode of ['drop', 'flush'] as const) {
      const store = createMemoryAgentRuntimeStore();
      const started = Promise.withResolvers<void>();
      const driver = {
        provider: 'test',
        modelId: 'm',
        async stream(_req: unknown, signal: AbortSignal) {
          return {
            parts: {
              [Symbol.asyncIterator]() {
                let sent = false;
                return {
                  async next() {
                    if (!sent) {
                      sent = true;
                      return {
                        done: false,
                        value: {
                          type: 'text-delta' as const,
                          id: 't1',
                          delta: 'held-before-stop',
                        },
                      };
                    }
                    started.resolve();
                    await new Promise<void>((_res, rej) => {
                      signal.addEventListener('abort', () => rej(signal.reason), {
                        once: true,
                      });
                    });
                    return { done: true as const, value: undefined };
                  },
                };
              },
            },
          };
        },
      };
      const runtime = createAgentRuntime({
        protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
        store,
        models: {
          resolve: () => ({
            descriptor: {
              provider: 'test',
              modelId: 'm',
              contextWindow: 10_000,
              capabilities: [],
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
        tools: () => ({}),
        loop: { stepBarriers: { stepText: 'after-tools', stepTextOnInterrupt: mode } },
      });
      const ticket = runtime.submit({
        conversationId: `c-int-${mode}`,
        idempotencyKey: `k-${mode}`,
        context: {},
        parts: [{ type: 'text', text: 'go' }],
        metadata: {},
      });
      await started.promise;
      const admission = await ticket.admission;
      await runtime.interrupt({ conversationId: `c-int-${mode}`, runId: admission.runId });
      const res = await ticket.result;
      await runtime.close();
      expect(res.reason).toBe('interrupted');
      const allText = res.message.parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('');
      if (mode === 'flush') expect(allText).toContain('held-before-stop');
      else expect(allText).not.toContain('held-before-stop');
    }
  });

  test('stepText: after-tools keeps text on auto-approval, passes full context to filterStepText, preserves [text, tool-call, tool-result] order, syncs stepResponseMessages, and ignores timeout on flush', async () => {
    const okTool = defineAgentTool({
      input: z.object({ v: z.string() }),
      execute: async ({ v }) => ({ echoed: v }),
    });
    const failingTool = defineAgentTool({
      input: z.object({}),
      execute: async () => {
        throw new Error('tool boom');
      },
    });

    // 1. Auto-approval (`isAutomatic: true`) keeps held step text, preserves `[reasoning, text, tool-call, ..., tool-result]` order,
    //    passes `{ step, interrupted, finishReason, toolCalls, toolResults }` to `filterStepText`, and syncs rewritten text into stepResponseMessages.
    const filterCalls: Array<{
      step: number;
      interrupted: boolean;
      finishReason: string;
      toolCallNames: string[];
      toolResultCount: number;
    }> = [];
    const driver1 = createScriptedModelDriver({
      provider: 'test',
      modelId: 'm',
      steps: [
        [
          { type: 'reasoning-start', id: 'r1' },
          { type: 'reasoning-delta', id: 'r1', delta: 'planning' },
          { type: 'reasoning-end', id: 'r1' },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: '  checking value  ' },
          { type: 'text-end', id: 't1' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'okTool', input: '{"v":"hello"}' },
          {
            type: 'finish',
            finishReason: 'tool-calls',
            usage: {
              inputTokens: { value: 10, provenance: 'provider-reported' },
              outputTokens: { value: 5, provenance: 'provider-reported' },
            },
          },
        ],
        [
          { type: 'text-start', id: 't2' },
          { type: 'text-delta', id: 't2', delta: 'Final answer.' },
          { type: 'text-end', id: 't2' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: {
              inputTokens: { value: 20, provenance: 'provider-reported' },
              outputTokens: { value: 4, provenance: 'provider-reported' },
            },
          },
        ],
      ],
    });
    const store1 = createMemoryAgentRuntimeStore();
    const runtime1 = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store: store1,
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'test',
            modelId: 'm',
            contextWindow: 10_000,
            capabilities: ['tools', 'reasoning'],
          },
          driver: driver1,
        }),
      },
      prompt: () => ({
        instructions: 'test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({ okTool }),
      loop: {
        toolApproval: { okTool: 'approved' },
        stepBarriers: {
          stepText: 'after-tools',
          filterStepText: (raw, ctx) => {
            filterCalls.push({
              step: ctx.step,
              interrupted: ctx.interrupted,
              finishReason: ctx.finishReason,
              toolCallNames: ctx.toolCalls.map((c) => c.toolName),
              toolResultCount: ctx.toolResults.length,
            });
            return ctx.step === 0 ? raw.trim().toUpperCase() : raw;
          },
        },
      },
    });
    const res1 = await runtime1.submit({
      conversationId: 'c-order-auto',
      idempotencyKey: 'k1',
      context: {},
      parts: [{ type: 'text', text: 'go' }],
      metadata: {},
    }).result;
    await runtime1.close();

    expect(res1.reason).toBe('success');
    expect(filterCalls).toEqual([
      {
        step: 0,
        interrupted: false,
        finishReason: 'tool-calls',
        toolCallNames: ['okTool'],
        toolResultCount: 1,
      },
      {
        step: 1,
        interrupted: false,
        finishReason: 'stop',
        toolCallNames: [],
        toolResultCount: 0,
      },
    ]);
    // Held text must be spliced at its original chronological position (after reasoning, BEFORE tool-call).
    expect(res1.message.parts.map((p) => p.type)).toEqual([
      'reasoning',
      'text',
      'tool-call',
      'tool-approval-request',
      'tool-approval-response',
      'tool-result',
      'text',
    ]);
    expect(res1.message.parts[1]).toEqual({ type: 'text', text: 'CHECKING VALUE' });
    // Step 1's request must see the filtered text in Step 0's assistant message (NOT raw '  checking value  ').
    const step1Assistant = driver1.requests[1]?.messages.find((m) => m.role === 'assistant');
    expect(step1Assistant?.role).toBe('assistant');
    if (step1Assistant?.role === 'assistant' && typeof step1Assistant.content !== 'string') {
      const assistantTexts = step1Assistant.content
        .filter((p) => p.type === 'text')
        .map((p) => p.text);
      expect(assistantTexts).toEqual(['CHECKING VALUE']);
    }

    // 2. When a tool fails under `stepText: 'after-tools'`, hidden pre-tool text is stripped from stepResponseMessages too.
    const driver2 = createScriptedModelDriver({
      provider: 'test',
      modelId: 'm',
      steps: [
        [
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'I already deleted the file!' },
          { type: 'text-end', id: 't1' },
          { type: 'tool-call', toolCallId: 'cf', toolName: 'failingTool', input: '{}' },
          {
            type: 'finish',
            finishReason: 'tool-calls',
            usage: {
              inputTokens: { value: 10, provenance: 'provider-reported' },
              outputTokens: { value: 5, provenance: 'provider-reported' },
            },
          },
        ],
        [
          { type: 'text-delta', id: 't2', delta: 'Sorry, it failed.' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: {
              inputTokens: { value: 20, provenance: 'provider-reported' },
              outputTokens: { value: 5, provenance: 'provider-reported' },
            },
          },
        ],
      ],
    });
    const runtime2 = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store: createMemoryAgentRuntimeStore(),
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'test',
            modelId: 'm',
            contextWindow: 10_000,
            capabilities: ['tools'],
          },
          driver: driver2,
        }),
      },
      prompt: () => ({
        instructions: 'test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({ failingTool }),
      loop: { stepBarriers: { stepText: 'after-tools' } },
    });
    const res2 = await runtime2.submit({
      conversationId: 'c-hide-fail',
      idempotencyKey: 'k2',
      context: {},
      parts: [{ type: 'text', text: 'delete it' }],
      metadata: {},
    }).result;
    await runtime2.close();
    expect(res2.reason).toBe('success');
    const step2MsgsJson = JSON.stringify(driver2.requests[1]?.messages ?? []);
    expect(step2MsgsJson).not.toContain('I already deleted the file!');

    // 3. `stepTextOnInterrupt: 'flush'` must NOT flush held text when abort is a timeout (only on user interrupt).
    const timeoutDriver = {
      provider: 'test',
      modelId: 'm',
      async stream(_req: unknown, signal: AbortSignal) {
        return {
          parts: {
            [Symbol.asyncIterator]() {
              let sent = false;
              return {
                async next() {
                  if (!sent) {
                    sent = true;
                    return {
                      done: false,
                      value: {
                        type: 'text-delta' as const,
                        id: 't1',
                        delta: 'timed-out-text',
                      },
                    };
                  }
                  await new Promise<void>((_res, rej) => {
                    if (signal.aborted) rej(signal.reason);
                    else
                      signal.addEventListener('abort', () => rej(signal.reason), {
                        once: true,
                      });
                  });
                  return { done: true as const, value: undefined };
                },
              };
            },
          },
        };
      },
    };
    const runtime3 = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store: createMemoryAgentRuntimeStore(),
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'test',
            modelId: 'm',
            contextWindow: 10_000,
            capabilities: [],
          },
          driver: timeoutDriver,
        }),
      },
      prompt: () => ({
        instructions: 'test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({}),
      loop: {
        idleTimeoutMs: 20,
        stepBarriers: { stepText: 'after-tools', stepTextOnInterrupt: 'flush' },
      },
    });
    const res3 = await runtime3.submit({
      conversationId: 'c-timeout-no-flush',
      idempotencyKey: 'k3',
      context: {},
      parts: [{ type: 'text', text: 'go' }],
      metadata: {},
    }).result;
    await runtime3.close();
    expect(res3.reason).toBe('timeout');
    expect(res3.message.parts.filter((p) => p.type === 'text')).toEqual([]);

    // 4. `onMaxReasoningChars: 'finish-length'` does NOT retain the overflowing reasoning chunk in stepResponseMessages.
    const reasonOverflowDriver = createScriptedModelDriver({
      provider: 'test',
      modelId: 'm',
      steps: [
        [
          { type: 'reasoning-start', id: 'r1' },
          { type: 'reasoning-delta', id: 'r1', delta: '12345' },
          { type: 'reasoning-delta', id: 'r1', delta: 'OVERFLOW_SECRET_CHUNK_999' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: {
              inputTokens: { value: 5, provenance: 'provider-reported' },
              outputTokens: { value: 20, provenance: 'provider-reported' },
            },
          },
        ],
        [
          { type: 'text-delta', id: 't2', delta: 'Short answer.' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: {
              inputTokens: { value: 10, provenance: 'provider-reported' },
              outputTokens: { value: 3, provenance: 'provider-reported' },
            },
          },
        ],
      ],
    });
    const runtime4 = createAgentRuntime({
      protocol: defineAgentProtocol({
        context: z.object({}),
        inputMetadata: z.object({}),
        terminalAcceptance: ({ steps, continuations }) =>
          steps?.at(-1)?.finishReason === 'length' && (continuations ?? 0) === 0
            ? { action: 'continue', message: { role: 'user', content: 'Be brief.' } }
            : { action: 'accept' },
      }),
      store: createMemoryAgentRuntimeStore(),
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'test',
            modelId: 'm',
            contextWindow: 10_000,
            capabilities: ['reasoning'],
          },
          driver: reasonOverflowDriver,
        }),
      },
      prompt: () => ({
        instructions: 'test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({}),
      loop: {
        stepBarriers: {
          maxReasoningCharsPerStep: 10,
          onMaxReasoningChars: 'finish-length',
        },
      },
    });
    const res4 = await runtime4.submit({
      conversationId: 'c-reason-trim',
      idempotencyKey: 'k4',
      context: {},
      parts: [{ type: 'text', text: 'solve' }],
      metadata: {},
    }).result;
    await runtime4.close();
    expect(res4.reason).toBe('success');
    const step2RequestJson = JSON.stringify(reasonOverflowDriver.requests[1]?.messages ?? []);
    expect(step2RequestJson).toContain('12345');
    expect(step2RequestJson).not.toContain('OVERFLOW_SECRET_CHUNK_999');
  });

  test('executeApprovalContinuations poisons entity on denial/non-executable/limit refusal, aborts uncooperative streaming tools cleanly, and merges held textProvider envelopes', async () => {
    // 1. Denied approval continuation on entity e1 blocks subsequent approved call on e1 via STEP_PREDECESSOR_FAILED,
    //    while allowing an approved call on independent entity e2 (negative control).
    const executedLog: string[] = [];
    const writeDoc = defineAgentTool({
      input: z.object({ id: z.string() }),
      needsApproval: true,
      execute: async ({ id }) => {
        executedLog.push(`write:${id}`);
        return { written: id };
      },
    });
    const publishDoc = defineAgentTool({
      input: z.object({ id: z.string() }),
      needsApproval: true,
      execute: async ({ id }) => {
        executedLog.push(`publish:${id}`);
        return { published: id };
      },
    });
    const approvalDriver = createScriptedModelDriver({
      provider: 'test',
      modelId: 'm',
      steps: [
        [
          { type: 'tool-call', toolCallId: 'c1', toolName: 'writeDoc', input: '{"id":"e1"}' },
          {
            type: 'tool-call',
            toolCallId: 'c2',
            toolName: 'publishDoc',
            input: '{"id":"e1"}',
          },
          {
            type: 'tool-call',
            toolCallId: 'c3',
            toolName: 'publishDoc',
            input: '{"id":"e2"}',
          },
          {
            type: 'finish',
            finishReason: 'tool-calls',
            usage: {
              inputTokens: { value: 10, provenance: 'provider-reported' },
              outputTokens: { value: 5, provenance: 'provider-reported' },
            },
          },
        ],
        [
          { type: 'text-delta', id: 't2', delta: 'Continuation handled.' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: {
              inputTokens: { value: 20, provenance: 'provider-reported' },
              outputTokens: { value: 4, provenance: 'provider-reported' },
            },
          },
        ],
      ],
    });
    const approvalStore = createMemoryAgentRuntimeStore();
    const approvalRuntime = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store: approvalStore,
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'test',
            modelId: 'm',
            contextWindow: 10_000,
            capabilities: ['tools'],
          },
          driver: approvalDriver,
        }),
      },
      prompt: () => ({
        instructions: 'test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({ writeDoc, publishDoc }),
      loop: {
        stepBarriers: {
          toolDependencies: ({ input }) => {
            const id =
              typeof input === 'object' && input !== null && 'id' in input
                ? String(input.id)
                : undefined;
            return id ? { writes: [id] } : undefined;
          },
          onPredecessorFailure: 'refuse',
        },
      },
    });
    const turn1 = await approvalRuntime.submit({
      conversationId: 'c-apr-barrier',
      idempotencyKey: 'k1',
      context: {},
      parts: [{ type: 'text', text: 'edit and publish' }],
      metadata: {},
    }).result;
    const reqs = turn1.message.parts.filter((p) => p.type === 'tool-approval-request');
    expect(reqs).toHaveLength(3);
    const reqByCallId = new Map(reqs.map((r) => [r.callId, r.approvalId]));
    const apr1 = reqByCallId.get('c1');
    const apr2 = reqByCallId.get('c2');
    const apr3 = reqByCallId.get('c3');
    expect(apr1 && apr2 && apr3).toBeTruthy();

    const turn2 = await approvalRuntime.submit({
      conversationId: 'c-apr-barrier',
      idempotencyKey: 'k2',
      role: 'tool',
      context: {},
      parts: [
        {
          type: 'tool-approval-response',
          approvalId: apr1 ?? '',
          approved: false,
          reason: 'nope',
        },
        { type: 'tool-approval-response', approvalId: apr2 ?? '', approved: true },
        { type: 'tool-approval-response', approvalId: apr3 ?? '', approved: true },
      ],
    }).result;
    await approvalRuntime.close();
    expect(turn2.reason).toBe('success');
    // c1 denied -> c2 on e1 refused without executing -> c3 on e2 executed normally.
    expect(executedLog).toEqual(['publish:e2']);
    const c2Result = turn2.message.parts.find(
      (p) => p.type === 'tool-result' && p.callId === 'c2',
    );
    expect(c2Result?.type === 'tool-result' && c2Result.outcome).toBe('error');
    expect(JSON.stringify(c2Result)).toContain('STEP_PREDECESSOR_FAILED');

    // 2. Non-executable approved tool on e1 also poisons e1 for a subsequent approved tool on e1.
    const nonExecLog: string[] = [];
    let removeFirstExecute = false;
    const stepTwoDriver = createScriptedModelDriver({
      provider: 'test',
      modelId: 'm',
      steps: [
        [
          { type: 'tool-call', toolCallId: 'n1', toolName: 'stepOne', input: '{"id":"e1"}' },
          { type: 'tool-call', toolCallId: 'n2', toolName: 'stepTwo', input: '{"id":"e1"}' },
          {
            type: 'finish',
            finishReason: 'tool-calls',
            usage: {
              inputTokens: { value: 10, provenance: 'provider-reported' },
              outputTokens: { value: 5, provenance: 'provider-reported' },
            },
          },
        ],
        [
          { type: 'text-delta', id: 't2', delta: 'Done.' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: {
              inputTokens: { value: 20, provenance: 'provider-reported' },
              outputTokens: { value: 4, provenance: 'provider-reported' },
            },
          },
        ],
      ],
    });
    const nonExecRuntime = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store: createMemoryAgentRuntimeStore(),
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'test',
            modelId: 'm',
            contextWindow: 10_000,
            capabilities: ['tools'],
          },
          driver: stepTwoDriver,
        }),
      },
      prompt: () => ({
        instructions: 'test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({
        stepOne: removeFirstExecute
          ? defineAgentTool({ input: z.object({ id: z.string() }), needsApproval: true })
          : defineAgentTool({
              input: z.object({ id: z.string() }),
              needsApproval: true,
              execute: async ({ id }) => {
                nonExecLog.push(`one:${id}`);
                return { ok: true };
              },
            }),
        stepTwo: defineAgentTool({
          input: z.object({ id: z.string() }),
          needsApproval: true,
          execute: async ({ id }) => {
            nonExecLog.push(`two:${id}`);
            return { ok: true };
          },
        }),
      }),
      loop: {
        stepBarriers: {
          toolDependencies: ({ input }) => {
            const id =
              typeof input === 'object' && input !== null && 'id' in input
                ? String(input.id)
                : undefined;
            return id ? { writes: [id] } : undefined;
          },
          onPredecessorFailure: 'refuse',
        },
      },
    });
    const nTurn1 = await nonExecRuntime.submit({
      conversationId: 'c-apr-nonexec',
      idempotencyKey: 'nk1',
      context: {},
      parts: [{ type: 'text', text: 'run two' }],
      metadata: {},
    }).result;
    const nReqs = nTurn1.message.parts.filter((p) => p.type === 'tool-approval-request');
    const nByCall = new Map(nReqs.map((r) => [r.callId, r.approvalId]));
    removeFirstExecute = true;
    const nTurn2 = await nonExecRuntime.submit({
      conversationId: 'c-apr-nonexec',
      idempotencyKey: 'nk2',
      role: 'tool',
      context: {},
      parts: [
        {
          type: 'tool-approval-response',
          approvalId: nByCall.get('n1') ?? '',
          approved: true,
        },
        {
          type: 'tool-approval-response',
          approvalId: nByCall.get('n2') ?? '',
          approved: true,
        },
      ],
    }).result;
    await nonExecRuntime.close();
    expect(nTurn2.reason).toBe('success');
    expect(nonExecLog).toEqual([]);
    const n2Result = nTurn2.message.parts.find(
      (p) => p.type === 'tool-result' && p.callId === 'n2',
    );
    expect(JSON.stringify(n2Result)).toContain('STEP_PREDECESSOR_FAILED');

    // 2b. maxToolCallsPerStep refusal during approval continuation rejects excess approved calls cleanly.
    const limitedLog: string[] = [];
    const limitedTool = defineAgentTool({
      input: z.object({ id: z.string() }),
      needsApproval: true,
      execute: async ({ id }) => {
        limitedLog.push(id);
        return { ok: id };
      },
    });
    const limitRuntime = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store: createMemoryAgentRuntimeStore(),
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'test',
            modelId: 'm',
            contextWindow: 10_000,
            capabilities: ['tools'],
          },
          driver: createScriptedModelDriver({
            provider: 'test',
            modelId: 'm',
            steps: [
              [
                {
                  type: 'tool-call',
                  toolCallId: 'l1',
                  toolName: 'limitedTool',
                  input: '{"id":"e1"}',
                },
                {
                  type: 'tool-call',
                  toolCallId: 'l2',
                  toolName: 'limitedTool',
                  input: '{"id":"e1"}',
                },
                {
                  type: 'finish',
                  finishReason: 'tool-calls',
                  usage: {
                    inputTokens: { value: 10, provenance: 'provider-reported' },
                    outputTokens: { value: 5, provenance: 'provider-reported' },
                  },
                },
              ],
              [
                { type: 'text-delta', id: 't2', delta: 'Limited done.' },
                {
                  type: 'finish',
                  finishReason: 'stop',
                  usage: {
                    inputTokens: { value: 15, provenance: 'provider-reported' },
                    outputTokens: { value: 4, provenance: 'provider-reported' },
                  },
                },
              ],
            ],
          }),
        }),
      },
      prompt: () => ({
        instructions: 'test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({ limitedTool }),
      loop: {
        stepBarriers: {
          maxToolCallsPerStep: 1,
          toolDependencies: ({ input }) => {
            const id =
              typeof input === 'object' && input !== null && 'id' in input
                ? String(input.id)
                : undefined;
            return id ? { writes: [id] } : undefined;
          },
          onPredecessorFailure: 'refuse',
        },
      },
    });
    const lTurn1 = await limitRuntime.submit({
      conversationId: 'c-apr-limit',
      idempotencyKey: 'lk1',
      context: {},
      parts: [{ type: 'text', text: 'limit test' }],
      metadata: {},
    }).result;
    // Turn 1 only requests approval for l1 because l2 hits maxToolCallsPerStep during step 0.
    // Submit two approved requests from a runtime with limit=2 on turn 1 and limit=1 on turn 2:
    await limitRuntime.close();
    expect(
      lTurn1.message.parts.filter((p) => p.type === 'tool-approval-request'),
    ).toHaveLength(1);

    let stepLimit = 2;
    const storeLimit = createMemoryAgentRuntimeStore();
    const limitDriver = createScriptedModelDriver({
      provider: 'test',
      modelId: 'm',
      steps: [
        [
          {
            type: 'tool-call',
            toolCallId: 'l1',
            toolName: 'limitedTool',
            input: '{"id":"e1"}',
          },
          {
            type: 'tool-call',
            toolCallId: 'l2',
            toolName: 'limitedTool',
            input: '{"id":"e1"}',
          },
          {
            type: 'finish',
            finishReason: 'tool-calls',
            usage: {
              inputTokens: { value: 10, provenance: 'provider-reported' },
              outputTokens: { value: 5, provenance: 'provider-reported' },
            },
          },
        ],
        [
          { type: 'text-delta', id: 't2', delta: 'Limited continuation done.' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: {
              inputTokens: { value: 15, provenance: 'provider-reported' },
              outputTokens: { value: 4, provenance: 'provider-reported' },
            },
          },
        ],
      ],
    });
    const makeLimitRuntime = () =>
      createAgentRuntime({
        protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
        store: storeLimit,
        models: {
          resolve: () => ({
            descriptor: {
              provider: 'test',
              modelId: 'm',
              contextWindow: 10_000,
              capabilities: ['tools'],
            },
            driver: limitDriver,
          }),
        },
        prompt: () => ({
          instructions: 'test',
          sections: [],
          instructionTokens: { provenance: 'unavailable' },
          contextDecision: 'unavailable',
        }),
        tools: () => ({ limitedTool }),
        loop: {
          stepBarriers: {
            maxToolCallsPerStep: stepLimit,
            toolDependencies: ({ input }) => {
              const id =
                typeof input === 'object' && input !== null && 'id' in input
                  ? String(input.id)
                  : undefined;
              return id ? { writes: [id] } : undefined;
            },
            onPredecessorFailure: 'refuse',
          },
        },
      });
    const rtA = makeLimitRuntime();
    const lt1 = await rtA.submit({
      conversationId: 'c-apr-limit-cont',
      idempotencyKey: 'lck1',
      context: {},
      parts: [{ type: 'text', text: 'two calls' }],
      metadata: {},
    }).result;
    await rtA.close();
    const lReqs = lt1.message.parts.filter((p) => p.type === 'tool-approval-request');
    expect(lReqs).toHaveLength(2);
    const lByCall = new Map(lReqs.map((r) => [r.callId, r.approvalId]));
    stepLimit = 1;
    const rtB = makeLimitRuntime();
    const lt2 = await rtB.submit({
      conversationId: 'c-apr-limit-cont',
      idempotencyKey: 'lck2',
      role: 'tool',
      context: {},
      parts: [
        {
          type: 'tool-approval-response',
          approvalId: lByCall.get('l1') ?? '',
          approved: true,
        },
        {
          type: 'tool-approval-response',
          approvalId: lByCall.get('l2') ?? '',
          approved: true,
        },
      ],
    }).result;
    await rtB.close();
    expect(lt2.reason).toBe('success');
    expect(limitedLog).toEqual(['e1']);
    const l2Result = lt2.message.parts.find(
      (p) => p.type === 'tool-result' && p.callId === 'l2',
    );
    expect(JSON.stringify(l2Result)).toContain('STEP_TOOL_CALL_LIMIT');

    // 3. Uncooperative streaming tool interrupted mid-stream does not run toModelOutput or emit late terminal result.
    let lateToModelCalled = false;
    const chunk1Sent = Promise.withResolvers<void>();
    const releaseChunk2 = Promise.withResolvers<void>();
    const uncooperativeStreamTool = defineAgentTool({
      input: z.object({}),
      toModelOutput: ({ output }) => {
        lateToModelCalled = true;
        return { type: 'text', value: JSON.stringify(output) };
      },
      async *execute() {
        yield { progress: 1 };
        chunk1Sent.resolve();
        await releaseChunk2.promise;
        yield { progress: 2 };
      },
    });
    const streamAbortRuntime = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store: createMemoryAgentRuntimeStore(),
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'test',
            modelId: 'm',
            contextWindow: 10_000,
            capabilities: ['tools'],
          },
          driver: createScriptedModelDriver({
            provider: 'test',
            modelId: 'm',
            steps: [
              [
                {
                  type: 'tool-call',
                  toolCallId: 'cs1',
                  toolName: 'uncooperativeStreamTool',
                  input: '{}',
                },
                {
                  type: 'finish',
                  finishReason: 'tool-calls',
                  usage: {
                    inputTokens: { value: 5, provenance: 'provider-reported' },
                    outputTokens: { value: 3, provenance: 'provider-reported' },
                  },
                },
              ],
            ],
          }),
        }),
      },
      prompt: () => ({
        instructions: 'test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({ uncooperativeStreamTool }),
    });
    const streamTicket = streamAbortRuntime.submit({
      conversationId: 'c-abort-stream-tool',
      idempotencyKey: 'as1',
      context: {},
      parts: [{ type: 'text', text: 'stream' }],
      metadata: {},
    });
    await chunk1Sent.promise;
    const admission = await streamTicket.admission;
    await streamAbortRuntime.interrupt({
      conversationId: 'c-abort-stream-tool',
      runId: admission.runId,
    });
    releaseChunk2.resolve();
    const abortedRun = await streamTicket.result;
    await streamAbortRuntime.close();
    expect(abortedRun.reason).toBe('interrupted');
    expect(lateToModelCalled).toBe(false);
    expect(abortedRun.message.parts.some((p) => p.type === 'tool-result')).toBe(false);

    // 4. Held stepText: 'after-tools' merges provider envelopes across text-start, text-delta, and text-end.
    const mergeEnvelopeDriver = createScriptedModelDriver({
      provider: 'openrouter',
      modelId: 'm',
      steps: [
        [
          {
            type: 'text-start',
            id: 't1',
            provider: { provider: 'openrouter', schemaVersion: 1, data: { startKey: 's1' } },
          },
          {
            type: 'text-delta',
            id: 't1',
            delta: 'Held response.',
            provider: { provider: 'openrouter', schemaVersion: 1, data: { deltaKey: 'd1' } },
          },
          {
            type: 'text-end',
            id: 't1',
            provider: { provider: 'openrouter', schemaVersion: 1, data: { endKey: 'e1' } },
          },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: {
              inputTokens: { value: 8, provenance: 'provider-reported' },
              outputTokens: { value: 4, provenance: 'provider-reported' },
            },
          },
        ],
      ],
    });
    const mergeRuntime = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store: createMemoryAgentRuntimeStore(),
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'openrouter',
            modelId: 'm',
            contextWindow: 10_000,
            capabilities: [],
          },
          driver: mergeEnvelopeDriver,
        }),
      },
      prompt: () => ({
        instructions: 'test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({}),
      loop: { stepBarriers: { stepText: 'after-tools' } },
    });
    const mergedRes = await mergeRuntime.submit({
      conversationId: 'c-merge-env',
      idempotencyKey: 'm1',
      context: {},
      parts: [{ type: 'text', text: 'hello' }],
      metadata: {},
    }).result;
    await mergeRuntime.close();
    expect(mergedRes.reason).toBe('success');
    const mergedText = mergedRes.message.parts.find((p) => p.type === 'text');
    expect(mergedText?.type === 'text' ? mergedText.provider : undefined).toEqual({
      provider: 'openrouter',
      schemaVersion: 1,
      data: { startKey: 's1', deltaKey: 'd1', endKey: 'e1' },
    });
  });
});
