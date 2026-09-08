import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { simulateReadableStream, type ToolSet, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  AgentProviderStreamCutError,
  agentConversationCardProjection,
  agentGoalStateSlot,
  agentTodoStateSlot,
  classifyProviderFailure,
  createAgentEventSearchTools,
  createAgentRuntime,
  createAgentScheduleService,
  createAgentStateSlotStore,
  createAgentStateTools,
  createMemoryAgentRuntimeStore,
  createSqliteAgentChildManager,
  createSqliteAgentEventSearch,
  createSqliteAgentProjectionStore,
  createSqliteAgentSpillStore,
  defineAgentProjection,
  defineAgentProtocol,
  defineStateSlot,
  recordAgentRetryDecision,
  renderAgentStateSlots,
} from '../src/agent-runtime';
import {
  createSqliteAgentRuntimeStore,
  type SqliteDatabase,
  type SqliteValue,
} from '../src/agent-runtime-sqlite-bun';
import {
  createFaultProviderServer,
  createReplayAgentProvider,
} from '../src/agent-runtime-testing';
import { mountAgent } from '../src/tools';

function sqlite(): SqliteDatabase {
  const raw = new Database(':memory:');
  return {
    exec: (sql) => raw.exec(sql),
    prepare(sql) {
      const statement = raw.query(sql);
      return {
        get: (...parameters: SqliteValue[]) => statement.get(...parameters),
        all: (...parameters: SqliteValue[]) => statement.all(...parameters),
        run: (...parameters: SqliteValue[]) => ({
          changes: statement.run(...parameters).changes,
        }),
      };
    },
    close: () => raw.close(),
  };
}

function executable(tools: ToolSet, name: string) {
  const execute = tools[name]?.execute;
  if (!execute) throw new Error(`expected executable tool ${name}`);
  return execute;
}

describe('agent runtime durable capabilities', () => {
  test('exports and imports one canonical event log byte for byte', async () => {
    const source = createMemoryAgentRuntimeStore();
    await source.appendEvent({
      conversationId: 'conversation-a',
      kind: 'state/set',
      occurredAt: '2026-09-08T01:02:03.000Z',
      payload: { name: 'goal', version: 1, value: 'ship', actor: 'human' },
    });
    const archive = await source.exportConversation('conversation-a');
    const restored = createMemoryAgentRuntimeStore();
    expect(await restored.importConversation(archive)).toEqual({
      conversationId: 'conversation-a',
      events: 1,
    });
    expect(await restored.exportConversation('conversation-a')).toEqual(archive);
  });

  test('restores normalized recovery state from the canonical conversation archive', async () => {
    const source = createMemoryAgentRuntimeStore();
    const timestamp = '2026-09-08T01:02:03.000Z';
    await source.acceptInputAndAssignRun({
      idempotencyKey: 'archive-request',
      input: {
        schemaVersion: 1,
        id: 'archive-input',
        conversationId: 'archive-runtime',
        role: 'user',
        status: 'committed',
        parts: [{ type: 'text', text: 'recover me' }],
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      run: {
        schemaVersion: 1,
        id: 'archive-run',
        conversationId: 'archive-runtime',
        inputMessageIds: ['archive-input'],
        assistantMessageId: 'archive-assistant',
        state: 'queued',
        revision: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });
    const bytes = await source.exportConversation('archive-runtime');
    const restored = createMemoryAgentRuntimeStore();
    await restored.importConversation(bytes);
    expect(await restored.loadSnapshot('archive-runtime')).toEqual(
      await source.loadSnapshot('archive-runtime'),
    );
    expect(
      (
        await restored.acceptInputAndAssignRun({
          idempotencyKey: 'archive-request',
          input: {
            schemaVersion: 1,
            id: 'other-input',
            conversationId: 'archive-runtime',
            role: 'user',
            status: 'committed',
            parts: [{ type: 'text', text: 'duplicate' }],
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          run: {
            schemaVersion: 1,
            id: 'other-run',
            conversationId: 'archive-runtime',
            inputMessageIds: ['other-input'],
            assistantMessageId: 'other-assistant',
            state: 'queued',
            revision: 0,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        })
      ).outcome,
    ).toBe('duplicate');
  });

  test('folds deterministic projections with an honest checkpoint', async () => {
    const database = sqlite();
    const runtime = createSqliteAgentRuntimeStore({ database });
    await runtime.store.appendEvent({
      conversationId: 'projection',
      kind: 'state/set',
      occurredAt: '2026-09-08T01:00:00.000Z',
      payload: { first: true },
    });
    const projections = createSqliteAgentProjectionStore({ sqlite: runtime });
    const first = await projections.advance('projection', agentConversationCardProjection);
    expect(first.uptoSeq).toBe(1);
    await runtime.store.appendEvent({
      conversationId: 'projection',
      kind: 'state/set',
      occurredAt: '2026-09-08T01:01:00.000Z',
      payload: { second: true },
    });
    const second = await projections.advance('projection', agentConversationCardProjection);
    expect(second.value.eventCount).toBe(2);
    const replacement = defineAgentProjection({
      ...agentConversationCardProjection,
      version: 2,
    });
    expect((await projections.advance('projection', replacement)).value).toEqual(second.value);
    await runtime.close();
  });

  test('state slots are store events and render independently of compacted history', async () => {
    const store = createMemoryAgentRuntimeStore();
    const slot = defineStateSlot({ name: 'answer', schema: z.object({ value: z.number() }) });
    const slots = createAgentStateSlotStore({ store, definitions: [slot] });
    await slots.set({
      conversationId: 'slots',
      name: 'answer',
      value: { value: 42 },
      actor: 'human',
    });
    const values = await slots.list('slots');
    expect(renderAgentStateSlots(values)).toContain('answer: {"value":42}');
    expect(
      (await store.readEvents({ conversationId: 'slots', limit: 10 })).items[0]?.kind,
    ).toBe('state/set');
  });

  test('goal and todo tools write the same durable state slots', async () => {
    const store = createMemoryAgentRuntimeStore();
    const state = createAgentStateSlotStore({
      store,
      definitions: [agentGoalStateSlot, agentTodoStateSlot],
    });
    const tools = mountAgent([], {
      runtimeTools: createAgentStateTools({ conversationId: 'state-tools', state }),
    });
    const options = { toolCallId: 'state', messages: [], context: undefined };
    await executable(tools, 'create_goal')({ objective: 'ship it' }, options);
    await executable(tools, 'todo_write')(
      { items: [{ step: 'verify', status: 'in_progress' }] },
      options,
    );
    expect((await state.get('state-tools', 'goal'))?.value).toEqual({
      objective: 'ship it',
      status: 'active',
    });
    expect((await state.get('state-tools', 'todo'))?.value).toEqual({
      items: [{ step: 'verify', status: 'in_progress' }],
    });
  });

  test('records the exact state-bearing provider request before the call', async () => {
    const store = createMemoryAgentRuntimeStore();
    const goal = defineStateSlot({
      name: 'goal-test',
      schema: z.object({ objective: z.string() }),
    });
    await createAgentStateSlotStore({ store, definitions: [goal] }).set({
      conversationId: 'provider-request',
      name: 'goal-test',
      value: { objective: 'survive compaction' },
      actor: 'human',
    });
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: 'answer' },
            { type: 'text-delta', id: 'answer', delta: 'ok' },
            { type: 'text-end', id: 'answer' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: undefined },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: { total: 1, text: 1, reasoning: undefined },
              },
            },
          ],
        }),
      }),
    });
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store,
      stateSlots: [goal],
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'fixture',
            modelId: 'fixture',
            contextWindow: 8_000,
            capabilities: [],
          },
          model,
        }),
      },
      prompt: () => ({
        instructions: 'base instructions',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({}),
    });
    const ticket = runtime.submit({
      conversationId: 'provider-request',
      idempotencyKey: 'request-1',
      context: {},
      parts: [{ type: 'text', text: 'go' }],
    });
    await ticket.result;
    const events = await store.readEvents({ conversationId: 'provider-request', limit: 20 });
    // The request names its instructions and messages by hash; the rendered
    // slot text is in the ledger one hop away, in the bodies it names.
    const request = events.items.find((event) => event.kind === 'provider/request');
    const requestPayload = request?.payload as {
      instructionsSha256?: string;
      messageShas?: string[];
    };
    expect(requestPayload.instructionsSha256).toHaveLength(64);
    expect(JSON.stringify(events.items.map((event) => event.payload))).toContain(
      'survive compaction',
    );
    await runtime.close();
  });

  test('search returns exact event seq and denies cross-conversation results by default', async () => {
    const database = sqlite();
    const runtime = createSqliteAgentRuntimeStore({ database });
    await runtime.store.appendEvent({
      conversationId: 'a',
      kind: 'state/set',
      payload: { text: 'needle own' },
    });
    await runtime.store.appendEvent({
      conversationId: 'b',
      kind: 'state/set',
      payload: { text: 'needle private' },
    });
    const search = createSqliteAgentEventSearch({ database });
    expect(await search({ requestingConversationId: 'a', query: 'needle' })).toEqual([
      expect.objectContaining({ conversationId: 'a', seq: 1 }),
    ]);
    const tools = mountAgent([], {
      runtimeTools: createAgentEventSearchTools({
        conversationId: 'a',
        search,
        store: runtime.store,
      }),
    });
    const options = { toolCallId: 'search', messages: [], context: undefined };
    expect(
      await executable(tools, 'session_event')({ conversationId: 'a', seq: 1 }, options),
    ).toEqual(expect.objectContaining({ conversationId: 'a', seq: 1 }));
    await expect(
      executable(tools, 'session_event')({ conversationId: 'b', seq: 1 }, options),
    ).rejects.toMatchObject({ output: { error: 'INTERNAL_SERVER_ERROR' } });
    await runtime.close();
  });

  test('spill lookup retains originating authorization and cleanup facts', async () => {
    const database = sqlite();
    const runtime = createSqliteAgentRuntimeStore({ database });
    let current = new Date('2026-09-08T01:00:00.000Z');
    const spills = createSqliteAgentSpillStore({
      sqlite: runtime,
      conversationId: 'spill',
      retentionMs: 1_000,
      now: () => current,
    });
    const data = new TextEncoder().encode('line one\nneedle 199999\n');
    const written = await spills.write({
      mediaType: 'text/plain',
      data,
      authorization: { operation: 'read', path: 'allowed.txt' },
    });
    expect(await spills.authorization?.(written.reference)).toEqual({
      operation: 'read',
      path: 'allowed.txt',
    });
    expect(
      await spills.search?.({ reference: written.reference, query: '199999', maxMatches: 5 }),
    ).toEqual([{ line: 2, text: 'needle 199999' }]);
    const archive = await runtime.store.exportConversation('spill');
    const restoredDatabase = sqlite();
    const restored = createSqliteAgentRuntimeStore({ database: restoredDatabase });
    await restored.store.importConversation(archive);
    const restoredSpills = createSqliteAgentSpillStore({
      sqlite: restored,
      conversationId: 'spill',
    });
    expect(
      new TextDecoder().decode(
        (
          await restoredSpills.read({
            reference: written.reference,
            offset: 0,
            maxBytes: data.byteLength,
          })
        ).data,
      ),
    ).toBe('line one\nneedle 199999\n');
    await restored.close();
    current = new Date('2026-09-08T01:00:02.000Z');
    expect(await spills.cleanup()).toEqual({ deleted: 1, bytes: data.byteLength });
    expect(
      (await runtime.store.readEvents({ conversationId: 'spill', limit: 10 })).items.map(
        (event) => event.kind,
      ),
    ).toEqual(['spill/created', 'spill/deleted']);
    await runtime.close();
  });

  test('replay and retry use declared models and record the durable boundary', async () => {
    const first = new MockLanguageModelV4();
    const second = new MockLanguageModelV4();
    const provider = createReplayAgentProvider({ attempts: { model: [first, second] } });
    expect(provider.create('model')).toBe(first);
    expect(provider.create('model')).toBe(second);
    expect(provider.calls('model')).toBe(2);
    const failure = classifyProviderFailure(new AgentProviderStreamCutError());
    const store = createMemoryAgentRuntimeStore();
    expect(
      await recordAgentRetryDecision({
        store,
        conversationId: 'retry',
        attempt: 1,
        failure,
        policy: { maxAttempts: 2, delayMs: () => 25 },
      }),
    ).toEqual({ retry: true, delayMs: 25 });
    expect(
      (await store.readEvents({ conversationId: 'retry', limit: 10 })).items[0]?.kind,
    ).toBe('retry/scheduled');
  });

  test('runtime retries a cut stream at a durable boundary without retaining partial output', async () => {
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'text-start', id: 'first' },
                { type: 'text-delta', id: 'first', delta: 'partial' },
                { type: 'error', error: new AgentProviderStreamCutError() },
              ],
            }),
          };
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: 'second' },
              { type: 'text-delta', id: 'second', delta: 'recovered' },
              { type: 'text-end', id: 'second' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: undefined },
                usage: {
                  inputTokens: {
                    total: 1,
                    noCache: 1,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: { total: 1, text: 1, reasoning: undefined },
                },
              },
            ],
          }),
        };
      },
    });
    const store = createMemoryAgentRuntimeStore();
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store,
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'fault',
            modelId: 'fault',
            contextWindow: 8_000,
            capabilities: [],
          },
          model,
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
    });
    const result = await runtime.submit({
      conversationId: 'runtime-retry',
      idempotencyKey: 'retry-input',
      context: {},
      parts: [{ type: 'text', text: 'go' }],
    }).result;
    expect({ calls, reason: result.reason }).toEqual({ calls: 2, reason: 'success' });
    expect(JSON.stringify(result.message.parts)).toContain('recovered');
    expect(JSON.stringify(result.message.parts)).not.toContain('partial');
    const kinds = (
      await store.readEvents({ conversationId: 'runtime-retry', limit: 100 })
    ).items.map((event) => event.kind);
    expect(kinds.indexOf('retry/scheduled')).toBeLessThan(kinds.indexOf('retry/started'));
    expect(kinds.filter((kind) => kind === 'provider/request')).toHaveLength(2);
    await runtime.close();
  });

  test('runtime never retries a provider failure after a tool has executed', async () => {
    let providerCalls = 0;
    let toolCalls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        providerCalls += 1;
        if (providerCalls === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                {
                  type: 'tool-call',
                  toolCallId: 'effect-1',
                  toolName: 'effect',
                  input: '{}',
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: undefined },
                  usage: {
                    inputTokens: {
                      total: 1,
                      noCache: 1,
                      cacheRead: undefined,
                      cacheWrite: undefined,
                    },
                    outputTokens: { total: 1, text: 1, reasoning: undefined },
                  },
                },
              ],
            }),
          };
        }
        return {
          stream: simulateReadableStream({
            chunks: [{ type: 'error', error: new AgentProviderStreamCutError() }],
          }),
        };
      },
    });
    const store = createMemoryAgentRuntimeStore();
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store,
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'fault',
            modelId: 'fault',
            contextWindow: 8_000,
            capabilities: [],
          },
          model,
        }),
      },
      prompt: () => ({
        instructions: 'do one effect',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({
        effect: tool({
          inputSchema: z.object({}),
          execute: () => {
            toolCalls += 1;
            return { ok: true };
          },
        }),
      }),
      loop: { retry: { maxAttempts: 3, delayMs: () => 0 } },
    });
    const result = await runtime.submit({
      conversationId: 'runtime-no-retry-after-tool',
      idempotencyKey: 'effect-input',
      context: {},
      parts: [{ type: 'text', text: 'go' }],
    }).result;
    expect({ providerCalls, toolCalls, reason: result.reason }).toEqual({
      providerCalls: 2,
      toolCalls: 1,
      reason: 'provider_failure',
    });
    expect(
      (
        await store.readEvents({
          conversationId: 'runtime-no-retry-after-tool',
          limit: 100,
        })
      ).items.some((event) => event.kind === 'retry/scheduled'),
    ).toBe(false);
    await runtime.close();
  });

  test('fault server scripts a stream cut and a credential-free recovery response', async () => {
    const server = await createFaultProviderServer({
      scenario: [
        { kind: 'stream-cut', afterBytes: 24 },
        { kind: 'pass', text: 'recovered' },
      ],
    });
    try {
      await expect(fetch(server.url).then((response) => response.text())).rejects.toThrow();
      const recovered = await fetch(server.url);
      expect(await recovered.text()).toContain('recovered');
      expect(server.calls()).toBe(2);
    } finally {
      await server.close();
    }
  });

  test('durable schedules mark late delivery and require timezone for every', async () => {
    const database = sqlite();
    const runtime = createSqliteAgentRuntimeStore({ database });
    let current = new Date('2026-09-08T01:00:00.000Z');
    const deliveries: unknown[] = [];
    const schedules = createAgentScheduleService({
      sqlite: runtime,
      now: () => current,
      dispatch: (delivery) => {
        deliveries.push(delivery);
      },
    });
    await expect(
      schedules.scheduleInput({
        conversationId: 'schedule',
        input: { wake: true },
        everyMs: 1_000,
      }),
    ).rejects.toThrow('explicit timeZone');
    await schedules.scheduleInput({
      conversationId: 'schedule',
      input: { wake: true },
      afterMs: 1_000,
    });
    current = new Date('2026-09-08T01:00:02.000Z');
    await schedules.tick();
    expect(deliveries).toEqual([
      expect.objectContaining({ schedule: expect.objectContaining({ lateByMs: 1_000 }) }),
    ]);
    const recurring = await schedules.scheduleInput({
      conversationId: 'schedule',
      input: { repeat: true },
      everyMs: 1_000,
      timeZone: 'Asia/Bangkok',
    });
    for (let occurrence = 1; occurrence <= 3; occurrence += 1) {
      current = new Date(current.getTime() + 1_000);
      await schedules.tick();
    }
    expect(await schedules.cancelSchedule('schedule', recurring.id)).toBeTrue();
    current = new Date(current.getTime() + 1_000);
    await schedules.tick();
    expect(
      deliveries.filter(
        (delivery) =>
          typeof delivery === 'object' &&
          delivery !== null &&
          'schedule' in delivery &&
          delivery.schedule &&
          typeof delivery.schedule === 'object' &&
          'id' in delivery.schedule &&
          delivery.schedule.id === recurring.id,
      ),
    ).toHaveLength(3);
    schedules.close();
    await runtime.close();
  });

  test('child seed is bounded and budget overrun stops at a policy boundary', async () => {
    const database = sqlite();
    const runtime = createSqliteAgentRuntimeStore({ database });
    await runtime.store.appendEvent({
      conversationId: 'parent',
      kind: 'state/set',
      payload: { fact: 1 },
    });
    await runtime.store.appendEvent({
      conversationId: 'parent',
      kind: 'state/set',
      payload: { fact: 2 },
    });
    let policy: string | undefined;
    const pending = Promise.withResolvers<{ resultReference?: string }>();
    const children = createSqliteAgentChildManager({
      sqlite: runtime,
      spawn: ({ seedArchive }) => {
        const seed = new TextDecoder().decode(seedArchive);
        expect(seed).toContain('"seq":1');
        expect(seed).not.toContain('"seq":2');
        return {
          result: pending.promise,
          stopPolicy: (name) => {
            policy = name;
          },
        };
      },
    });
    const child = await children.spawnChild({
      parentConversationId: 'parent',
      childConversationId: 'child',
      seedUptoSeq: 1,
      childInput: { task: 'answer' },
      budget: { tokens: 100, usd: 0.01 },
    });
    const usage = {
      inputTokens: { value: 1, provenance: 'provider-reported' },
      outputTokens: { value: 1, provenance: 'provider-reported' },
      cost: { value: 0.012, currency: 'USD', provenance: 'provider-reported' },
    } satisfies Parameters<typeof children.recordStepUsage>[0]['usage'];
    const boundary = await children.recordStepUsage({
      childConversationId: child.childConversationId,
      usage,
      elapsedMs: 1,
    });
    expect(boundary).toEqual(
      expect.objectContaining({ stop: true, policyName: 'child-budget' }),
    );
    expect(boundary.overrun.usd).toBeCloseTo(0.002, 8);
    expect(policy).toBe('child-budget');
    expect(
      (
        await runtime.store.readEvents({
          conversationId: child.childConversationId,
          limit: 20,
        })
      ).items.some(
        (event) =>
          event.kind === 'child/state' &&
          JSON.stringify(event.payload).includes('child-budget'),
      ),
    ).toBeTrue();
    pending.resolve({});
    await children.waitChild(child.childConversationId);
    await runtime.close();
  });
});
