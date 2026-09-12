import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createAgentChildTools, createSqliteAgentChildManager } from '../src/agent-runtime';
import {
  createSqliteAgentRuntimeStore,
  type SqliteDatabase,
  type SqliteValue,
} from '../src/agent-runtime-sqlite-bun';

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

type Tools = ReturnType<typeof createAgentChildTools>;
type ToolOutput = Record<string, unknown>;

function toolByName(tools: Tools, name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`tool ${name} is missing`);
  return tool;
}

async function listAgents(tools: Tools, parentConversationId: string) {
  const output = (await toolByName(tools, 'list_agents').handler({
    input: { parentConversationId },
  })) as {
    children: Array<{ childConversationId: string; state: string; resultReference?: string }>;
  };
  return output.children;
}

describe('a settling child has one terminal outcome', () => {
  test('persistence failure stops the already spawned child', async () => {
    const durable = createSqliteAgentRuntimeStore({ database: sqlite() });
    const stopped: string[] = [];
    const failure = new Error('fixture persistence refused');
    const manager = createSqliteAgentChildManager({
      sqlite: {
        ...durable,
        transaction: async () => {
          throw failure;
        },
      },
      spawn: () => ({
        result: Promise.reject(new Error('child also failed')),
        stopPolicy: (reason) => {
          stopped.push(reason);
        },
      }),
    });
    try {
      await expect(
        manager.spawnChild({
          parentConversationId: 'parent',
          childConversationId: 'child',
          childInput: {},
          budget: { tokens: 10 },
        }),
      ).rejects.toBe(failure);
      expect(stopped).toEqual(['spawn-persistence-failed']);
      expect(manager.listChildren('parent')).toEqual([]);
    } finally {
      await durable.close();
    }
  });
  /**
   * ADR 0179 asks first whether the `subagent` tool result and `list_agents`
   * can disagree about a terminal child. By construction `child-tools.ts` waits
   * on the settlement and then reads the same rows `list_agents` serves, so the
   * reproduction must find either the divergence or its absence on a real
   * child manager. This test is that reproduction — if it stays green, there is
   * no divergence to fix and no divergence-prevention code is added.
   */
  test('subagent output equals the list_agents row after a successful settle', async () => {
    const database = sqlite();
    const durable = createSqliteAgentRuntimeStore({ database });
    const manager = createSqliteAgentChildManager({
      sqlite: durable,
      spawn: () => ({
        result: Promise.resolve({ resultReference: 'answer-1' }),
        stopPolicy: () => undefined,
      }),
    });
    const tools = createAgentChildTools(manager);

    const result = (await toolByName(tools, 'subagent').handler({
      input: {
        parentConversationId: 'parent',
        childInput: { task: 'answer' },
        budget: { tokens: 100 },
      },
    })) as ToolOutput;
    const children = await listAgents(tools, 'parent');
    const listed = children.find(
      (record) => record.childConversationId === result.childConversationId,
    );
    if (!listed) throw new Error('child missing from list_agents');

    expect(result.state).toBe('finished');
    expect(result.resultReference).toBe('answer-1');
    expect({
      childConversationId: result.childConversationId,
      state: result.state,
      resultReference: result.resultReference,
    }).toEqual({
      childConversationId: listed.childConversationId,
      state: listed.state,
      resultReference: listed.resultReference,
    });
    await durable.close();
  });

  test('subagent output equals the list_agents row after a failed settle', async () => {
    const database = sqlite();
    const durable = createSqliteAgentRuntimeStore({ database });
    const manager = createSqliteAgentChildManager({
      sqlite: durable,
      spawn: () => ({
        result: Promise.reject(new Error('child host failed')),
        stopPolicy: () => undefined,
      }),
    });
    const tools = createAgentChildTools(manager);

    const result = (await toolByName(tools, 'subagent').handler({
      input: {
        parentConversationId: 'parent',
        childInput: { task: 'fail' },
        budget: { tokens: 100 },
      },
    })) as ToolOutput;
    const children = await listAgents(tools, 'parent');
    const listed = children.find(
      (record) => record.childConversationId === result.childConversationId,
    );
    if (!listed) throw new Error('child missing from list_agents');

    expect(result.state).toBe('stopped');
    expect(result.resultReference).toBeUndefined();
    expect(result.state).toBe(listed.state);
    expect(result.resultReference).toBe(listed.resultReference);
    await durable.close();
  });
});
