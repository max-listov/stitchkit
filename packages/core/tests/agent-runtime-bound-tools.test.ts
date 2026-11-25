/**
 * A model acts for the conversation it runs in, never for one it names.
 *
 * The address of a live conversation is authority: whoever holds it can spend a
 * parent's child budget, message and interrupt its children, and place or
 * cancel its schedules. So the child and schedule tools are bound to the
 * conversation of the run they serve, as the state and event search tools are,
 * and the model's input carries no conversation address at all. How the run
 * reaches a factory is `agent-runtime-tools-take-the-run.test.ts`.
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
  createSqliteAgentRuntimeStore,
  type SqliteDatabase,
  type SqliteValue,
} from '../src/agent-runtime/sqlite-bun';
import {
  type AgentChildManager,
  type AgentChildRecord,
  type AgentSchedule,
  type AgentScheduleService,
  createAgentChildManager,
  createAgentChildTools,
  createAgentScheduleTools,
} from '../src/entrypoints/agent-runtime';
import { issuedRunContext } from './support/issued-run-context';

const at = '2026-11-21T14:00:00.000Z';

function tool<T extends { name: string }>(tools: readonly T[], name: string): T {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`tool ${name} is missing`);
  return found;
}

/** A manager that records which parent every call acted for. */
function recordingManager() {
  const actedFor: string[] = [];
  const record = (parentConversationId: string): AgentChildRecord => ({
    childConversationId: `child-of-${parentConversationId}`,
    parentConversationId,
    seedUptoSeq: 0,
    budget: { tokens: 1 },
    usage: { tokens: 0, usd: 0, milliseconds: 0 },
    state: 'finished',
    createdAt: at,
    updatedAt: at,
  });
  const manager: Pick<
    AgentChildManager,
    'spawnChild' | 'listChildren' | 'sendMessage' | 'interruptChild' | 'waitChild'
  > = {
    spawnChild: async (request) => {
      actedFor.push(request.parentConversationId);
      return record(request.parentConversationId);
    },
    listChildren: async (parentConversationId) => {
      actedFor.push(parentConversationId);
      return [record(parentConversationId)];
    },
    sendMessage: async (parentConversationId) => {
      actedFor.push(parentConversationId);
    },
    interruptChild: async (parentConversationId) => {
      actedFor.push(parentConversationId);
    },
    waitChild: async () => undefined,
  };
  return { actedFor, manager };
}

function recordingSchedules() {
  const actedFor: string[] = [];
  const schedule = (conversationId: string): AgentSchedule => ({
    id: 'schedule',
    conversationId,
    kind: 'after',
    nextAt: at,
    input: null,
    state: 'scheduled',
    occurrence: 0,
    createdAt: at,
    updatedAt: at,
  });
  const service: Pick<
    AgentScheduleService,
    'scheduleInput' | 'cancelSchedule' | 'listSchedules'
  > = {
    scheduleInput: async (request) => {
      actedFor.push(request.conversationId);
      return schedule(request.conversationId);
    },
    cancelSchedule: async (conversationId) => {
      actedFor.push(conversationId);
      return true;
    },
    listSchedules: async (conversationId) => {
      actedFor.push(conversationId);
      return [];
    },
  };
  return { actedFor, service };
}

test('child tools act only for the conversation of their run', async () => {
  const { actedFor, manager } = recordingManager();
  const tools = createAgentChildTools({
    manager,
    run: issuedRunContext('mine'),
  });
  const budget = { tokens: 10 };
  await tool(tools, 'subagent').handler({ input: { childInput: 'go', budget } });
  await tool(tools, 'subagent_fork').handler({
    input: { childInput: 'go', budget, seedUptoSeq: 1 },
  });
  await tool(tools, 'list_agents').handler({ input: {} });
  await tool(tools, 'send_message').handler({
    input: { childConversationId: 'child-of-mine', input: 'more' },
  });
  await tool(tools, 'interrupt_agent').handler({
    input: { childConversationId: 'child-of-mine' },
  });
  expect(new Set(actedFor)).toEqual(new Set(['mine']));

  // A model that names another conversation is refused by the schema before any call.
  for (const [name, input] of [
    ['subagent', { parentConversationId: 'theirs', childInput: 'go', budget }],
    ['list_agents', { parentConversationId: 'theirs' }],
    ['send_message', { parentConversationId: 'theirs', childConversationId: 'c', input: 1 }],
    ['interrupt_agent', { parentConversationId: 'theirs', childConversationId: 'c' }],
  ] as const) {
    expect(tool(tools, name).input.safeParse(input).success).toBe(false);
  }
});

test('schedule tools act only for the conversation of their run', async () => {
  const { actedFor, service } = recordingSchedules();
  const tools = createAgentScheduleTools({
    service,
    run: issuedRunContext('mine'),
  });
  await tool(tools, 'schedule_after').handler({ input: { input: 'later', afterMs: 1000 } });
  await tool(tools, 'schedule_at').handler({
    input: { input: 'then', at: '2026-11-22T00:00:00+08:00' },
  });
  await tool(tools, 'schedule_every').handler({
    input: { input: 'tick', everyMs: 60_000, timeZone: 'Asia/Kuala_Lumpur' },
  });
  await tool(tools, 'schedule_list').handler({ input: {} });
  await tool(tools, 'schedule_cancel').handler({ input: { scheduleId: 'schedule' } });
  expect(actedFor).toEqual(['mine', 'mine', 'mine', 'mine', 'mine']);

  for (const [name, input] of [
    ['schedule_after', { conversationId: 'theirs', input: 'x', afterMs: 1 }],
    ['schedule_list', { conversationId: 'theirs' }],
    ['schedule_cancel', { conversationId: 'theirs', scheduleId: 'schedule' }],
  ] as const) {
    expect(tool(tools, name).input.safeParse(input).success).toBe(false);
  }
});

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

test('a child of another conversation is out of reach of the bound tools', async () => {
  const durable = createSqliteAgentRuntimeStore({ database: sqlite() });
  const manager = createAgentChildManager({
    remainingBudget: () => ({}),
    maxActiveChildren: 8,
    store: durable.store,
    host: durable.host,
    // A child that keeps running until it is stopped.
    spawn: () => ({ result: new Promise(() => undefined), stopPolicy: () => undefined }),
  });
  try {
    const theirs = await manager.spawnChild({
      parentConversationId: 'theirs',
      childInput: 'work',
      budget: { tokens: 10 },
    });
    const tools = createAgentChildTools({ manager, run: issuedRunContext('mine') });
    const target = { childConversationId: theirs.childConversationId };
    await expect(
      tool(tools, 'send_message').handler({ input: { ...target, input: 'stop that' } }),
    ).rejects.toThrow('Unknown child conversation for this parent');
    await expect(tool(tools, 'interrupt_agent').handler({ input: target })).rejects.toThrow(
      'Unknown child conversation for this parent',
    );
    expect((await manager.listChildren('theirs')).map((child) => child.state)).toEqual([
      'running',
    ]);
    expect(await tool(tools, 'list_agents').handler({ input: {} })).toEqual({ children: [] });
  } finally {
    await manager.stopChildren('theirs');
    await durable.close();
  }
});
