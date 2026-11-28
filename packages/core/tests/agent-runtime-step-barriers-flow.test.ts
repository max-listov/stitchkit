/**
 * Step barriers on the paths a plain step does not take: an approval answered
 * before the first step, a tool that streams, a `prepareStep` that trims the
 * history, a tool with its own context schema, calls past the bound that need
 * approval, a contract's own tool names, and the next step.
 */
import { describe, expect, test } from 'bun:test';
import { jsonSchema, tool } from 'ai';
import { z } from 'zod';
import { createStepCallScheduler } from '../src/agent-runtime/run-step-barriers';
import { createToolDependencyResolver } from '../src/entrypoints/agent-runtime';
import { fromAiSdkTools } from '../src/entrypoints/agent-runtime/ai-sdk';
import { defineContract } from '../src/entrypoints/contract';
import { implement } from '../src/entrypoints/server';
import { defineAgentTool, mountAgentTools } from '../src/entrypoints/tools';
import {
  answer,
  approvalIds,
  call,
  finish,
  harness,
  idOf,
  noInput,
  partsOf,
  results,
  round,
} from './support/step-barriers-harness';

describe('step barriers beyond a plain step', () => {
  test('after-tools: a denied approval answered before the first step does not hide the reply', async () => {
    const danger = defineAgentTool({ input: noInput, execute: async () => 'did it' });
    const h = harness(
      [round([call('d', 'danger'), finish('tool-calls')]), answer('OK, I will not do that')],
      { danger },
      { stepText: 'after-tools' },
      { toolApproval: { danger: 'user-approval' }, toolApprovalSecret: 'step-barrier-secret' },
    );
    await h.say('k');
    const ids = approvalIds(await h.store.loadSnapshot('c'));
    expect(ids).toHaveLength(1);
    const second = await h.answerApprovals('k2', ids, false);
    const after = await h.store.loadSnapshot('c');
    await h.runtime.close();
    expect(second.reason).toBe('success');
    expect(
      partsOf(after).some(
        (part) => part.type === 'text' && part.text === 'OK, I will not do that',
      ),
    ).toBe(true);
  });

  test('a tool that streams still streams under the barriers, and runs as its own method', async () => {
    const ran: string[] = [];
    const streaming = defineAgentTool({
      input: noInput,
      async *execute() {
        ran.push(typeof this);
        yield 'partial';
        yield 'done';
      },
    });
    const h = harness(
      [round([call('g', 'streaming'), finish('tool-calls')]), answer()],
      { streaming },
      { maxToolCallsPerStep: 2 },
    );
    await h.say('k');
    const after = await h.store.loadSnapshot('c');
    await h.runtime.close();
    expect(ran).toEqual(['object']);
    expect(
      partsOf(after).some(
        (part) => part.type === 'tool-result' && part.callId === 'g' && part.output === 'done',
      ),
    ).toBe(true);
  });

  test('a prepareStep that trims the history to a fixed window still starts a new step', async () => {
    const counted = defineAgentTool({ input: noInput, execute: async () => 'ok' });
    const h = harness(
      [
        round([call('a', 'counted'), finish('tool-calls')]),
        round([call('b', 'counted'), finish('tool-calls')]),
        round([call('c', 'counted'), finish('tool-calls')]),
        answer(),
      ],
      { counted },
      { maxToolCallsPerStep: 1 },
      { prepareStep: ({ messages }) => ({ messages: messages.slice(-2) }) },
    );
    await h.say('k');
    const after = await h.store.loadSnapshot('c');
    await h.runtime.close();
    expect(results(after)).toEqual(['a:success', 'b:success', 'c:success']);
  });

  test('read after write holds when the write declares a context schema and the read does not', async () => {
    const order: string[] = [];
    const aiNoInput = jsonSchema<Record<string, string>>({ type: 'object' });
    const write = tool({
      inputSchema: aiNoInput,
      // A schema of its own: the SDK validates it before the write runs.
      contextSchema: jsonSchema<Record<string, never>>(
        { type: 'object' },
        { validate: async () => ({ success: true, value: {} }) },
      ),
      execute: async () => {
        order.push('write-start');
        await Bun.sleep(30);
        order.push('write-end');
        return 'written';
      },
    });
    const read = tool({
      inputSchema: aiNoInput,
      execute: async () => {
        order.push('read');
        return 'value';
      },
    });
    const h = harness(
      [
        round([
          call('w', 'write', { id: 'e1' }),
          call('r', 'read', { id: 'e1' }),
          finish('tool-calls'),
        ]),
        answer(),
      ],
      await fromAiSdkTools({ write, read }),
      {
        toolDependencies: createToolDependencyResolver({
          effects: { write: 'write', read: 'read' },
          entityOf: (_name, input) => idOf(input),
        }),
      },
    );
    await h.say('k');
    await h.runtime.close();
    expect(order).toEqual(['write-start', 'write-end', 'read']);
  });

  test('a write waits for the earlier read of its entity, and a second write for the first', async () => {
    const order: string[] = [];
    const slow = (name: string, ms: number) =>
      defineAgentTool({
        input: noInput,
        execute: async (input) => {
          order.push(`${name}:${idOf(input)}:start`);
          await Bun.sleep(ms);
          order.push(`${name}:${idOf(input)}:end`);
          return name;
        },
      });
    const h = harness(
      [
        round([
          call('r', 'read', { id: 'e' }),
          call('w1', 'write', { id: 'e' }),
          call('w2', 'write', { id: 'e' }),
          finish('tool-calls'),
        ]),
        answer(),
      ],
      { read: slow('read', 30), write: slow('write', 20) },
      {
        toolDependencies: createToolDependencyResolver({
          effects: { write: 'write', read: 'read' },
          entityOf: (_name, input) => idOf(input),
        }),
      },
    );
    await h.say('k');
    await h.runtime.close();
    expect(order).toEqual([
      'read:e:start',
      'read:e:end',
      'write:e:start',
      'write:e:end',
      'write:e:start',
      'write:e:end',
    ]);
  });

  test('a call past the bound is not put to approval; the next step counts afresh', async () => {
    const ran: string[] = [];
    const danger = defineAgentTool({
      input: noInput,
      execute: async (_input, { toolCallId }) => {
        ran.push(toolCallId);
        return 'did it';
      },
    });
    const h = harness(
      [
        round([call('d1', 'danger'), call('d2', 'danger'), finish('tool-calls')]),
        round([call('d3', 'danger'), finish('tool-calls')]),
        answer('after'),
      ],
      { danger },
      { maxToolCallsPerStep: 1 },
      { toolApproval: { danger: 'user-approval' }, toolApprovalSecret: 'step-barrier-secret' },
    );
    await h.say('k');
    const first = await h.store.loadSnapshot('c');
    expect(approvalIds(first)).toHaveLength(1);
    expect(results(first)).toEqual(['d2:error']);
    await h.answerApprovals('k2', approvalIds(first), true);
    const ids = approvalIds(await h.store.loadSnapshot('c')).slice(1);
    expect(ids).toHaveLength(1);
    await h.answerApprovals('k3', ids, true);
    const after = await h.store.loadSnapshot('c');
    await h.runtime.close();
    expect(ran).toEqual(['d1', 'd3']);
    expect(results(after)).toEqual(['d2:error', 'd1:success', 'd3:success']);
  });

  test("a contract's effects order its mounted tools by their mounted names", async () => {
    const order: string[] = [];
    const notes = defineContract(
      { prefix: 'notes', scope: 'public' },
      {
        put: {
          method: 'POST',
          path: '/put',
          desc: 'Write a note',
          effect: 'write',
          input: z.object({ id: z.string() }),
          output: z.object({ ok: z.boolean() }),
        },
        get: {
          method: 'POST',
          path: '/get',
          desc: 'Read a note',
          effect: 'read',
          input: z.object({ id: z.string() }),
          output: z.object({ ok: z.boolean() }),
        },
      },
    );
    const tools = mountAgentTools(
      [
        implement(notes, {
          put: async () => {
            order.push('put-start');
            await Bun.sleep(30);
            order.push('put-end');
            return { ok: true };
          },
          get: async () => {
            order.push('get');
            return { ok: true };
          },
        }),
      ],
      { access: { open: 'local-operator' } },
    );
    // The mounted names are not the endpoint keys the effects are declared on.
    const [putName, getName] = ['put_note', 'get_note'];
    expect(Object.keys(tools).sort()).toEqual(['get_note', 'put_note']);
    const resolver = createToolDependencyResolver({
      contracts: [notes],
      entityOf: (_name, input) => idOf(input),
    });
    expect(resolver({ toolName: putName, input: { id: 'n' } })).toEqual({
      writes: ['n'],
    });
    const h = harness(
      [
        round([
          call('p', putName, { id: 'n' }),
          call('g', getName, { id: 'n' }),
          finish('tool-calls'),
        ]),
        answer(),
      ],
      tools,
      { toolDependencies: resolver },
    );
    await h.say('k');
    await h.runtime.close();
    expect(order).toEqual(['put-start', 'put-end', 'get']);
  });

  test('a tool call and its result are each checkpointed once', async () => {
    const plain = defineAgentTool({ input: noInput, execute: async () => 'ok' });
    const h = harness(
      [round([call('a', 'plain'), finish('tool-calls')]), answer()],
      { plain },
      { maxToolCallsPerStep: 3 },
    );
    await h.say('k');
    await h.runtime.close();
    // The call's checkpoint, its result's, and the step end's — not each tool
    // checkpoint written a second time.
    const firstStep = h.events.flatMap((event) =>
      event.type === 'assistant-checkpoint' && event.message.parts.length <= 2
        ? [event.message.parts.map((part) => part.type).join('+')]
        : [],
    );
    expect(firstStep).toEqual(['tool-call', 'tool-call+tool-result', 'tool-call+tool-result']);
  });

  test('toolDependencies + user-approval on a write does not deadlock a dependent read in the same step', async () => {
    const order: string[] = [];
    const write = defineAgentTool({
      input: noInput,
      execute: async () => {
        order.push('write');
        return 'written';
      },
    });
    const read = defineAgentTool({
      input: noInput,
      execute: async () => {
        order.push('read');
        return 'value';
      },
    });
    const h = harness(
      [
        round([
          call('w', 'write', { id: 'e1' }),
          call('r', 'read', { id: 'e1' }),
          finish('tool-calls'),
        ]),
        answer('done'),
      ],
      { write, read },
      {
        toolDependencies: createToolDependencyResolver({
          effects: { write: 'write', read: 'read' },
          entityOf: (_name, input) => idOf(input),
        }),
      },
      {
        toolApproval: { write: 'user-approval' },
        toolApprovalSecret: 'barrier-approval-secret',
      },
    );
    await h.say('k');
    const first = await h.store.loadSnapshot('c');
    expect(approvalIds(first)).toHaveLength(1);
    expect(order).toEqual(['read']);
    const second = await h.answerApprovals('k2', approvalIds(first), false);
    await h.runtime.close();
    expect(second.reason).toBe('success');
    expect(order).toEqual(['read']);
  });

  test('toolDependencies + tool.needsApproval returning true settles barrier immediately without hanging', async () => {
    const order: string[] = [];
    const write = defineAgentTool({
      input: noInput,
      needsApproval: async () => true,
      execute: async () => {
        order.push('write');
        return 'written';
      },
    });
    const read = defineAgentTool({
      input: noInput,
      execute: async () => {
        order.push('read');
        return 'value';
      },
    });
    const h = harness(
      [
        round([
          call('w', 'write', { id: 'e1' }),
          call('r', 'read', { id: 'e1' }),
          finish('tool-calls'),
        ]),
        answer('done'),
      ],
      { write, read },
      {
        toolDependencies: createToolDependencyResolver({
          effects: { write: 'write', read: 'read' },
          entityOf: (_name, input) => idOf(input),
        }),
      },
    );
    await h.say('k');
    await h.runtime.close();
    expect(order).toEqual(['read']);
  });

  test('an arrow tool returning an AsyncIterable holds the barrier for later reads, and a regular dependent read emits one tool-result', async () => {
    const order: string[] = [];
    const w1 = defineAgentTool({
      input: noInput,
      execute: async () => {
        order.push('w1-start');
        await Bun.sleep(20);
        order.push('w1-end');
        return 'w1-done';
      },
    });
    // Arrow wrapper returning an AsyncIterable: not an AsyncGeneratorFunction.
    const w2 = defineAgentTool({
      input: noInput,
      execute: () =>
        (async function* () {
          order.push('w2-start');
          yield 'w2-partial';
          await Bun.sleep(30);
          order.push('w2-end');
          yield 'w2-done';
        })(),
    });
    const r1 = defineAgentTool({
      input: noInput,
      execute: async () => {
        order.push('r1');
        return 'r1-done';
      },
    });
    const h = harness(
      [
        round([
          call('c-w1', 'w1', { id: 'e1' }),
          call('c-w2', 'w2', { id: 'e1' }),
          call('c-r1', 'r1', { id: 'e1' }),
          finish('tool-calls'),
        ]),
        answer(),
      ],
      { w1, w2, r1 },
      {
        toolDependencies: createToolDependencyResolver({
          effects: { w1: 'write', w2: 'write', r1: 'read' },
          entityOf: (_name, input) => idOf(input),
        }),
      },
    );
    await h.say('k');
    const after = await h.store.loadSnapshot('c');
    await h.runtime.close();

    expect(order).toEqual(['w1-start', 'w1-end', 'w2-start', 'w2-end', 'r1']);
    const w2Results = partsOf(after).filter(
      (part) => part.type === 'tool-result' && part.callId === 'c-w2',
    );
    expect(w2Results).toHaveLength(1);
    expect(w2Results[0]).toMatchObject({ outcome: 'success', output: 'w2-done' });

    // Negative control: a regular dependent tool must not be turned into a
    // streaming generator emitting duplicate preliminary + final tool-result parts.
    const r1Results = partsOf(after).filter(
      (part) => part.type === 'tool-result' && part.callId === 'c-r1',
    );
    expect(r1Results).toHaveLength(1);
    expect(r1Results[0]).toMatchObject({ outcome: 'success', output: 'r1-done' });
    const r1Completed = h.events.filter(
      (event) =>
        event.type === 'tool-status' &&
        event.callId === 'c-r1' &&
        event.status === 'completed',
    );
    expect(r1Completed).toHaveLength(1);
  });

  test('a throwing arrow-AsyncIterable tool releases the barrier for later dependent calls without deadlock', async () => {
    const order: string[] = [];
    const w1 = defineAgentTool({
      input: noInput,
      execute: async () => {
        order.push('w1-start');
        await Bun.sleep(20);
        order.push('w1-end');
        return 'w1-done';
      },
    });
    // Arrow wrapper returning an AsyncIterable that throws after its first yield.
    const w2 = defineAgentTool({
      input: noInput,
      execute: () =>
        (async function* () {
          order.push('w2-start');
          yield 'w2-partial';
          await Bun.sleep(20);
          order.push('w2-throw');
          throw new Error('w2-boom');
        })(),
    });
    const r1 = defineAgentTool({
      input: noInput,
      execute: async () => {
        order.push('r1');
        return 'r1-done';
      },
    });
    const h = harness(
      [
        round([
          call('c-w1', 'w1', { id: 'e1' }),
          call('c-w2', 'w2', { id: 'e1' }),
          call('c-r1', 'r1', { id: 'e1' }),
          finish('tool-calls'),
        ]),
        answer(),
      ],
      { w1, w2, r1 },
      {
        toolDependencies: createToolDependencyResolver({
          effects: { w1: 'write', w2: 'write', r1: 'read' },
          entityOf: (_name, input) => idOf(input),
        }),
      },
    );
    const outcome = await Promise.race([
      h.say('k'),
      Bun.sleep(1_000).then(() => 'deadlock' as const),
    ]);
    const after = await h.store.loadSnapshot('c');
    await h.runtime.close();

    expect(outcome).not.toBe('deadlock');
    expect(order).toEqual(['w1-start', 'w1-end', 'w2-start', 'w2-throw', 'r1']);
    const w2Results = partsOf(after).filter(
      (part) => part.type === 'tool-result' && part.callId === 'c-w2',
    );
    expect(w2Results).toHaveLength(1);
    expect(w2Results[0]).toMatchObject({ outcome: 'error' });
    const r1Results = partsOf(after).filter(
      (part) => part.type === 'tool-result' && part.callId === 'c-r1',
    );
    expect(r1Results).toHaveLength(1);
    expect(r1Results[0]).toMatchObject({ outcome: 'success', output: 'r1-done' });
  });

  test('a client-side tool without execute under either toolApproval form does not deadlock a dependent call', async () => {
    for (const mode of ['map', 'function'] as const) {
      const order: string[] = [];
      const clientWrite = defineAgentTool({ input: noInput });
      const read = defineAgentTool({
        input: noInput,
        execute: async () => {
          order.push('read');
          return 'value';
        },
      });
      const h = harness(
        [
          round([
            call('cw', 'clientWrite', { id: 'e1' }),
            call('r', 'read', { id: 'e1' }),
            finish('tool-calls'),
          ]),
          answer('done'),
        ],
        { clientWrite, read },
        {
          toolDependencies: createToolDependencyResolver({
            effects: { clientWrite: 'write', read: 'read' },
            entityOf: (_name, input) => idOf(input),
          }),
        },
        {
          toolApproval: mode === 'map' ? { clientWrite: 'approved' } : () => 'approved',
          toolApprovalSecret: 'client-tool-secret',
        },
      );
      const outcome = await Promise.race([
        h.say(`k-${mode}`),
        Bun.sleep(500).then(() => 'deadlock' as const),
      ]);
      await h.runtime.close();
      expect(outcome).not.toBe('deadlock');
      expect(order).toEqual(['read']);
    }
  });

  test('toolApproval returning undefined or object approved still holds the step barrier until execute finishes', async () => {
    for (const decision of [
      'not-applicable' as const,
      { type: 'approved' as const },
    ] as const) {
      const order: string[] = [];
      const write = defineAgentTool({
        input: noInput,
        execute: async () => {
          order.push('write-start');
          await Bun.sleep(25);
          order.push('write-end');
          return 'written';
        },
      });
      const read = defineAgentTool({
        input: noInput,
        execute: async () => {
          order.push('read');
          return 'value';
        },
      });
      const h = harness(
        [
          round([
            call('w', 'write', { id: 'e1' }),
            call('r', 'read', { id: 'e1' }),
            finish('tool-calls'),
          ]),
          answer('done'),
        ],
        { write, read },
        {
          toolDependencies: createToolDependencyResolver({
            effects: { write: 'write', read: 'read' },
            entityOf: (_name, input) => idOf(input),
          }),
        },
        {
          toolApproval: () => decision,
          toolApprovalSecret: 'object-status-secret',
        },
      );
      await h.say('k');
      await h.runtime.close();
      expect(order).toEqual(['write-start', 'write-end', 'read']);
    }
  });

  test('an onInputAvailable throw after entering the ledger settles the barrier for dependent calls', async () => {
    const write = defineAgentTool({
      input: noInput,
      onInputAvailable: async () => {
        throw new Error('input rejected');
      },
      execute: async () => 'written',
    });
    const read = defineAgentTool({
      input: noInput,
      execute: async () => 'value',
    });
    const scheduler = createStepCallScheduler({
      toolDependencies: createToolDependencyResolver({
        effects: { write: 'write', read: 'read' },
        entityOf: (_name, input) => idOf(input),
      }),
    });
    const writeSlot = scheduler.enter('write', { id: 'e1' });
    const readSlot = scheduler.enter('read', { id: 'e1' });
    await expect(
      (async () => {
        try {
          await write.onInputAvailable?.({
            input: { id: 'e1' },
            toolCallId: 'w',
            messages: [],
          });
        } finally {
          writeSlot.settle(false);
        }
      })(),
    ).rejects.toThrow('input rejected');
    const outcome = await Promise.race([
      readSlot
        .waitAhead()
        .then(() => read.execute?.({ id: 'e1' }, { toolCallId: 'r', messages: [] })),
      Bun.sleep(500).then(() => 'deadlock' as const),
    ]);
    expect(outcome).toBe('value');
  });
});
