import { Database } from 'bun:sqlite';
import { describe, expect, spyOn, test } from 'bun:test';
import { ChildStateEventPayloadSchema } from '../src/agent-runtime/children-contract';
import { spawnChild } from '../src/agent-runtime/children-spawn';
import { createChildManagerState } from '../src/agent-runtime/children-state';
import {
  createSqliteAgentRuntimeStore,
  type SqliteDatabase,
  type SqliteValue,
} from '../src/agent-runtime/sqlite-bun';
import {
  createAgentChildManager,
  createAgentChildTools,
} from '../src/entrypoints/agent-runtime';
import { issuedRunContext } from './support/issued-run-context';

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

async function listAgents(tools: Tools) {
  const output = (await toolByName(tools, 'list_agents').handler({
    input: {},
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
    const manager = createAgentChildManager({
      remainingBudget: () => ({}),
      maxActiveChildren: 8,
      store: durable.store,
      host: {
        ...durable.host,
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
      expect(await manager.listChildren('parent')).toEqual([]);
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
    const manager = createAgentChildManager({
      remainingBudget: () => ({}),
      maxActiveChildren: 8,
      store: durable.store,
      host: durable.host,
      spawn: () => ({
        result: Promise.resolve({ resultReference: 'answer-1' }),
        stopPolicy: () => undefined,
      }),
    });
    const tools = createAgentChildTools({ manager, run: issuedRunContext('parent') });

    const result = (await toolByName(tools, 'subagent').handler({
      input: {
        childInput: { task: 'answer' },
        budget: { tokens: 100 },
      },
    })) as ToolOutput;
    const children = await listAgents(tools);
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
    const manager = createAgentChildManager({
      remainingBudget: () => ({}),
      maxActiveChildren: 8,
      store: durable.store,
      host: durable.host,
      spawn: () => ({
        result: Promise.reject(new Error('child host failed')),
        stopPolicy: () => undefined,
      }),
    });
    const tools = createAgentChildTools({ manager, run: issuedRunContext('parent') });

    const result = (await toolByName(tools, 'subagent').handler({
      input: {
        childInput: { task: 'fail' },
        budget: { tokens: 100 },
      },
    })) as ToolOutput;
    const children = await listAgents(tools);
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

  test('children-usage calls stopPolicy at most once when enforcement times out or fails', async () => {
    const realSetTimeout = globalThis.setTimeout;
    const fastBound = new Proxy(realSetTimeout, {
      apply: (target, thisArg, args: unknown[]) =>
        Reflect.apply(target, thisArg, [
          args[0],
          args[1] === 10_000 ? 10 : args[1],
          ...args.slice(2),
        ]),
    });
    const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation(fastBound);
    try {
      for (const mode of ['timeout', 'sync-throw', 'async-reject'] as const) {
        const durable = createSqliteAgentRuntimeStore({ database: sqlite() });
        let stopCalls = 0;
        try {
          const manager = createAgentChildManager({
            remainingBudget: () => ({}),
            maxActiveChildren: 8,
            store: durable.store,
            host: durable.host,
            spawn: () => ({
              result: new Promise(() => undefined),
              stopPolicy: () => {
                stopCalls += 1;
                if (mode === 'timeout') return new Promise(() => undefined);
                if (mode === 'sync-throw') throw new Error('sync boom');
                return Promise.reject(new Error('async boom'));
              },
            }),
          });
          await manager.spawnChild({
            parentConversationId: 'parent',
            childConversationId: `child-${mode}`,
            childInput: {},
            budget: { tokens: 10 },
          });
          const boundary = await manager.recordStepUsage({
            childConversationId: `child-${mode}`,
            usage: {
              inputTokens: { value: 6, provenance: 'provider-reported' },
              outputTokens: { value: 6, provenance: 'provider-reported' },
            },
            elapsedMs: 5,
          });
          expect(stopCalls).toBe(1);
          expect(boundary).toMatchObject({
            stop: true,
            enforced: false,
            policyName: 'child-budget',
          });
        } finally {
          await durable.close();
        }
      }
    } finally {
      timerSpy.mockRestore();
    }
  });

  test('children-usage reconciles enforced: true into both journals after a concurrent budget crossing and survives purge', async () => {
    for (const purgeParent of [false, true] as const) {
      const durable = createSqliteAgentRuntimeStore({ database: sqlite() });
      let readCount = 0;
      const bothRead = Promise.withResolvers<void>();
      const coordinatedHost = {
        ...durable.host,
        read: async <T>(work: Parameters<typeof durable.host.read<T>>[0]): Promise<T> => {
          const value = await durable.host.read(work);
          readCount += 1;
          // Hold the two concurrent recordStepUsage pre-reads until both see usage = 0.
          if (readCount >= 2 && readCount <= 3) {
            if (readCount === 3) bothRead.resolve();
            await bothRead.promise;
          }
          return value;
        },
      };
      let stopCalls = 0;
      try {
        const manager = createAgentChildManager({
          remainingBudget: () => ({}),
          maxActiveChildren: 8,
          store: durable.store,
          host: coordinatedHost,
          spawn: () => ({
            result: new Promise(() => undefined),
            stopPolicy: async () => {
              stopCalls += 1;
              if (purgeParent) {
                await durable.store.purgeConversation?.({ conversationId: 'parent' });
              }
            },
          }),
        });
        await manager.spawnChild({
          parentConversationId: 'parent',
          childConversationId: 'child-race',
          childInput: {},
          budget: { tokens: 10 },
        });
        const step = () =>
          manager.recordStepUsage({
            childConversationId: 'child-race',
            usage: {
              inputTokens: { value: 3, provenance: 'provider-reported' },
              outputTokens: { value: 3, provenance: 'provider-reported' },
            },
            elapsedMs: 5,
          });
        const results = await Promise.all([step(), step()]);
        expect(stopCalls).toBe(1);
        expect(results.some((entry) => entry.stop && entry.enforced)).toBe(true);

        const childEvents = (
          await durable.store.readEvents({ conversationId: 'child-race', limit: 30 })
        ).items
          .filter((event) => event.kind === 'child/state')
          .map((event) => ChildStateEventPayloadSchema.parse(event.payload));
        expect(
          childEvents.some(
            (payload) =>
              'policyName' in payload &&
              payload.policyName === 'child-budget' &&
              payload.enforced === true,
          ),
        ).toBe(true);

        if (!purgeParent) {
          const parentEvents = (
            await durable.store.readEvents({ conversationId: 'parent', limit: 30 })
          ).items
            .filter((event) => event.kind === 'child/state')
            .map((event) => ChildStateEventPayloadSchema.parse(event.payload));
          expect(
            parentEvents.some(
              (payload) =>
                'policyName' in payload &&
                payload.policyName === 'child-budget' &&
                payload.enforced === true,
            ),
          ).toBe(true);
        }
      } finally {
        await durable.close();
      }
    }
  });

  test('state.settlements removes each child entry once its settlement finishes', async () => {
    const durable = createSqliteAgentRuntimeStore({ database: sqlite() });
    const first = Promise.withResolvers<{ resultReference?: string }>();
    const second = Promise.withResolvers<{ resultReference?: string }>();
    try {
      const state = createChildManagerState({
        remainingBudget: () => ({}),
        maxActiveChildren: 8,
        store: durable.store,
        host: durable.host,
        spawn: ({ childConversationId }) => ({
          result: childConversationId === 'child-a' ? first.promise : second.promise,
          stopPolicy: () => undefined,
        }),
      });
      await spawnChild(state, () => undefined, {
        parentConversationId: 'parent',
        childConversationId: 'child-a',
        childInput: {},
        budget: { tokens: 10 },
      });
      await spawnChild(state, () => undefined, {
        parentConversationId: 'parent',
        childConversationId: 'child-b',
        childInput: {},
        budget: { tokens: 10 },
      });
      expect(state.settlements.size).toBe(2);

      const waitA = state.settlements.get('child-a')?.settled;
      first.resolve({ resultReference: 'done-a' });
      await waitA;
      expect(state.settlements.has('child-a')).toBe(false);
      expect(state.settlements.size).toBe(1);

      const waitB = state.settlements.get('child-b')?.settled;
      second.reject(new Error('child-b failed'));
      await waitB;
      expect(state.settlements.has('child-b')).toBe(false);
      expect(state.settlements.size).toBe(0);
    } finally {
      await durable.close();
    }
  });

  test('createAgentChildManager waitChild resolves when a child settles and subsequent waitChild still reads the terminal record from store', async () => {
    const durable = createSqliteAgentRuntimeStore({ database: sqlite() });
    const done = Promise.withResolvers<{ resultReference?: string }>();
    const failed = Promise.withResolvers<{ resultReference?: string }>();
    try {
      let tick = 1_700_000_000_000;
      const manager = createAgentChildManager({
        remainingBudget: () => ({}),
        maxActiveChildren: 8,
        store: durable.store,
        host: durable.host,
        now: () => {
          tick += 1_000;
          return new Date(tick);
        },
        spawn: ({ childConversationId }) => ({
          result: childConversationId === 'child-ok' ? done.promise : failed.promise,
          stopPolicy: () => undefined,
        }),
      });
      await manager.spawnChild({
        parentConversationId: 'parent',
        childConversationId: 'child-ok',
        childInput: { task: 'finish' },
        budget: { tokens: 10 },
      });
      await manager.spawnChild({
        parentConversationId: 'parent',
        childConversationId: 'child-fail',
        childInput: { task: 'fail' },
        budget: { tokens: 10 },
      });

      let okSettled = false;
      const firstWait = manager.waitChild('child-ok').then(() => {
        okSettled = true;
      });
      await Bun.sleep(10);
      expect(okSettled).toBe(false);

      done.resolve({ resultReference: 'terminal-ref' });
      await firstWait;
      expect(okSettled).toBe(true);

      await manager.waitChild('child-ok');
      const afterOk = await manager.listChildren('parent');
      expect(
        afterOk.find((record) => record.childConversationId === 'child-ok'),
      ).toMatchObject({
        childConversationId: 'child-ok',
        state: 'finished',
        resultReference: 'terminal-ref',
      });

      failed.reject(new Error('child host crashed'));
      await manager.waitChild('child-fail');
      await manager.waitChild('child-fail');
      const afterFail = await manager.listChildren('parent');
      expect(
        afterFail.find((record) => record.childConversationId === 'child-fail'),
      ).toMatchObject({
        childConversationId: 'child-fail',
        state: 'stopped',
      });
    } finally {
      await durable.close();
    }
  });
});
