/**
 * The built-in tools act for the run that called them, within limits the host
 * declared.
 *
 * Before, a factory took a free `conversationId` from the host: nothing tied it
 * to the run the tools served, so a host bug acted for another conversation.
 * The child manager and the schedule service had no limits of their own: the
 * model chose how many children to spawn and what budget each got, and a
 * schedule could repeat every millisecond. Now every factory takes the run
 * context the runtime passes to `tools()`, a hand-built one is refused, and
 * the manager and the service cannot be created without their limits.
 */
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  createSqliteAgentRuntimeStore,
  type SqliteDatabase,
  type SqliteValue,
} from '../src/agent-runtime/sqlite-bun';
import {
  type AgentRuntimeRunContext,
  agentGoalStateSlot,
  createAgentChildManager,
  createAgentChildTools,
  createAgentEventSearchTools,
  createAgentRuntime,
  createAgentScheduleService,
  createAgentScheduleTools,
  createAgentStateSlotStore,
  createAgentStateTools,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../src/entrypoints/agent-runtime';
import { mountAgent } from '../src/entrypoints/tools/agent';
import { issuedRunContext } from './support/issued-run-context';

type StreamPart =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<
    infer Part
  >
    ? Part
    : never;

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

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

const closers: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

describe('the run reaches a tool factory only from the runtime', () => {
  test('state tools built in tools() write to the conversation of the run that called them', async () => {
    const store = createMemoryAgentRuntimeStore();
    const state = createAgentStateSlotStore({ store, definitions: [agentGoalStateSlot] });
    const model = new MockLanguageModelV4({
      doStream: async (options) => ({
        stream: simulateReadableStream<StreamPart>({
          chunks: options.prompt.some((message) => message.role === 'tool')
            ? [
                { type: 'text-start', id: 'text' },
                { type: 'text-delta', id: 'text', delta: 'done' },
                { type: 'text-end', id: 'text' },
                { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
              ]
            : [
                {
                  type: 'tool-call',
                  toolCallId: 'goal',
                  toolName: 'create_goal',
                  input: JSON.stringify({ objective: 'ship it' }),
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: undefined },
                  usage,
                },
              ],
        }),
      }),
    });
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store,
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'test',
            modelId: 'bound',
            contextWindow: 4096,
            capabilities: [],
          },
          model,
        }),
      },
      prompt: () => ({
        instructions: 'Test',
        instructionTokens: { value: 1, provenance: 'computed' },
        contextDecision: 'fits',
        availableHistoryTokens: 1000,
        sections: [],
      }),
      tools: (run) =>
        mountAgent([], {
          access: { open: 'local-operator' },
          runtimeTools: createAgentStateTools({ state, run }),
        }),
    });
    closers.push(() => runtime.close());
    for (const conversationId of ['first', 'second']) {
      const result = await runtime.submit({
        conversationId,
        idempotencyKey: conversationId,
        context: {},
        parts: [{ type: 'text', text: 'set a goal' }],
        metadata: {},
      }).result;
      expect(result.reason).toBe('success');
    }
    expect((await state.get('first', 'goal'))?.value).toEqual({
      objective: 'ship it',
      status: 'active',
    });
    expect((await state.get('second', 'goal'))?.value).toEqual({
      objective: 'ship it',
      status: 'active',
    });
  });

  test('a run context built by hand is refused by every factory', () => {
    const durable = createSqliteAgentRuntimeStore({ database: sqlite() });
    closers.push(() => durable.close());
    const genuine = issuedRunContext('mine');
    // Every field a run context has, only not issued by a runtime.
    const forged: AgentRuntimeRunContext<unknown> = { ...genuine, run: { ...genuine.run } };
    const state = createAgentStateSlotStore({
      store: durable.store,
      definitions: [agentGoalStateSlot],
    });
    const service = {
      scheduleInput: async () => {
        throw new Error('unreachable');
      },
      cancelSchedule: async () => false,
      listSchedules: async () => [],
    };
    const manager = createAgentChildManager({
      store: durable.store,
      host: durable.host,
      spawn: () => {
        throw new Error('unreachable');
      },
      remainingBudget: () => ({ tokens: 10 }),
      maxActiveChildren: 1,
    });
    const search = async () => [];
    const factories = {
      createAgentChildTools: (run: AgentRuntimeRunContext<unknown>) =>
        createAgentChildTools({ manager, run }),
      createAgentScheduleTools: (run: AgentRuntimeRunContext<unknown>) =>
        createAgentScheduleTools({ service, run }),
      createAgentStateTools: (run: AgentRuntimeRunContext<unknown>) =>
        createAgentStateTools({ state, run }),
      createAgentEventSearchTools: (run: AgentRuntimeRunContext<unknown>) =>
        createAgentEventSearchTools({ run, search, store: durable.store }),
    };
    for (const [name, create] of Object.entries(factories)) {
      expect(create(genuine).length).toBeGreaterThan(0);
      expect(() => create(forged)).toThrow(
        `${name} takes the run context the runtime passes to tools(); this one was not issued by a runtime`,
      );
    }
  });
});

describe('the child manager bounds what the model may ask for', () => {
  const spawned = () => ({
    result: new Promise<never>(() => undefined),
    stopPolicy: () => undefined,
  });

  test('is not created without its limits', () => {
    const durable = createSqliteAgentRuntimeStore({ database: sqlite() });
    closers.push(() => durable.close());
    const untyped: Record<string, unknown> = { sqlite: durable, spawn: spawned };
    expect(() =>
      Reflect.apply(createAgentChildManager, undefined, [
        { ...untyped, maxActiveChildren: 1 },
      ]),
    ).toThrow('createAgentChildManager requires remainingBudget');
    expect(() =>
      Reflect.apply(createAgentChildManager, undefined, [
        { ...untyped, remainingBudget: () => ({}) },
      ]),
    ).toThrow('createAgentChildManager requires maxActiveChildren');
    expect(() =>
      createAgentChildManager({
        store: durable.store,
        host: durable.host,
        spawn: spawned,
        remainingBudget: () => ({}),
        maxActiveChildren: 0,
      }),
    ).toThrow('maxActiveChildren must be a positive safe integer, received 0');
  });

  test('refuses a child past maxActiveChildren, with no budget, and from a spent parent', async () => {
    const durable = createSqliteAgentRuntimeStore({ database: sqlite() });
    closers.push(() => durable.close());
    let remaining: { tokens?: number } = { tokens: 100 };
    const spawns: number[] = [];
    const manager = createAgentChildManager({
      store: durable.store,
      host: durable.host,
      spawn: ({ budget }) => {
        spawns.push(budget.tokens ?? -1);
        return spawned();
      },
      remainingBudget: () => remaining,
      maxActiveChildren: 1,
    });
    closers.push(() => manager.stopChildren('parent'));
    const tools = createAgentChildTools({ manager, run: issuedRunContext('parent') });
    const subagent = tools[0];
    // The model leaves the budget out; the parent's remainder is granted.
    const first = await manager.spawnChild({
      parentConversationId: 'parent',
      childInput: 'work',
      budget: {},
    });
    expect(first.budget).toEqual({ tokens: 100 });
    // The tool would wait for a child it spawned; the refusal comes before any spawn.
    await expect(
      manager.spawnChild({
        parentConversationId: 'parent',
        childInput: 'more',
        budget: { tokens: 1 },
      }),
    ).rejects.toThrow('The parent already has 1 active children, the limit is 1');
    await expect(
      subagent.handler({ input: { childInput: 'more', budget: { tokens: 1 } } }),
    ).rejects.toThrow('The parent already has 1 active children, the limit is 1');
    await manager.stopChildren('parent');

    remaining = {};
    await expect(
      manager.spawnChild({ parentConversationId: 'parent', childInput: 'x', budget: {} }),
    ).rejects.toThrow(
      'A child budget names at least one limit; the parent remainder and the request name none',
    );
    remaining = { tokens: 0 };
    await expect(
      manager.spawnChild({
        parentConversationId: 'parent',
        childInput: 'x',
        budget: { tokens: 5 },
      }),
    ).rejects.toThrow('The parent has no child budget left in tokens');
    expect(spawns).toEqual([100]);
  });
});

describe('the schedule service bounds what the model may ask for', () => {
  const dispatch = () => undefined;

  test('is not created without its limits', () => {
    const durable = createSqliteAgentRuntimeStore({ database: sqlite() });
    closers.push(() => durable.close());
    for (const [present, missing] of [
      [{ minIntervalMs: 1_000 }, 'maxActivePerConversation'],
      [{ maxActivePerConversation: 1 }, 'minIntervalMs'],
    ] as const) {
      expect(() =>
        Reflect.apply(createAgentScheduleService, undefined, [
          { sqlite: durable, dispatch, ...present },
        ]),
      ).toThrow(`createAgentScheduleService requires ${missing}`);
    }
  });

  test('refuses a repeat shorter than minIntervalMs and a schedule past the active limit', async () => {
    const durable = createSqliteAgentRuntimeStore({ database: sqlite() });
    closers.push(() => durable.close());
    const service = createAgentScheduleService({
      host: durable.host,
      dispatch,
      maxActivePerConversation: 1,
      minIntervalMs: 60_000,
    });
    closers.push(() => service.close());
    const tools = createAgentScheduleTools({ service, run: issuedRunContext('mine') });
    const every = tools.find((candidate) => candidate.name === 'schedule_every');
    const after = tools.find((candidate) => candidate.name === 'schedule_after');
    if (!every || !after) throw new Error('schedule tools are missing');
    await expect(
      every.handler({ input: { input: 'tick', everyMs: 1, timeZone: 'UTC' } }),
    ).rejects.toThrow('A repeating schedule fires at most every 60000 ms, received everyMs 1');
    await after.handler({ input: { input: 'later', afterMs: 1_000 } });
    await expect(after.handler({ input: { input: 'again', afterMs: 1_000 } })).rejects.toThrow(
      'The conversation already holds 1 active schedules, the limit is 1',
    );
    // Another conversation has its own count.
    await service.scheduleInput({ conversationId: 'theirs', input: 'x', afterMs: 1_000 });
    expect(await service.listSchedules('mine')).toHaveLength(1);
  });
});
