import { Database } from 'bun:sqlite';
import { describe, expect, spyOn, test } from 'bun:test';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  createSqliteAgentRuntimeStore,
  type SqliteDatabase,
  type SqliteValue,
} from '../src/agent-runtime/sqlite-bun';
import {
  createAgentChildManager,
  createAgentRuntime,
  defineAgentProtocol,
} from '../src/entrypoints/agent-runtime';

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

/** A provider that never answers until told to — the parent is stopped while it waits. */
function blockedModel(release: Promise<void>) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        async pull(controller) {
          await release;
          controller.close();
        },
      }),
    }),
  });
}

describe('parent stop cascades to children', () => {
  /**
   * `stopChildren` existed with nothing calling it: a child manager is
   * composed by the application, and the runtime did not know about it. The
   * runtime now takes the manager and stops the parent's children after the
   * parent's terminal is durable — and it records what happened to each.
   */
  test('a reachable child is stopped and an unreachable one is lost, after the parent terminal', async () => {
    const database = sqlite();
    const durable = createSqliteAgentRuntimeStore({ database });
    const stopped: string[] = [];
    const children = createAgentChildManager({
      remainingBudget: () => ({}),
      maxActiveChildren: 8,
      store: durable.store,
      host: durable.host,
      spawn: ({ childConversationId }) => ({
        result: new Promise(() => undefined),
        stopPolicy: (name) => {
          stopped.push(`${childConversationId}:${name}`);
        },
        // The second child sits on a node that no longer answers.
        reachable: () => childConversationId !== 'child-unreachable',
      }),
    });
    for (const childConversationId of ['child-reachable', 'child-unreachable']) {
      await children.spawnChild({
        parentConversationId: 'parent',
        childConversationId,
        childInput: { task: 'wait' },
        budget: { tokens: 1_000 },
      });
    }

    const release = Promise.withResolvers<void>();
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store: durable.store,
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'test',
            modelId: 'blocked',
            contextWindow: 8_000,
            capabilities: [],
          },
          model: blockedModel(release.promise),
        }),
      },
      prompt: () => ({
        instructions: 'wait',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({}),
      children,
    });
    const ticket = runtime.submit({
      conversationId: 'parent',
      idempotencyKey: 'parent-input',
      context: {},
      parts: [{ type: 'text', text: 'go' }],
    });
    await ticket.accepted;
    // Let the run reach the provider before pulling it down.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runtime.stop('parent')).toBeTrue();
    release.resolve();
    const result = await ticket.result;
    expect(result.reason).toBe('interrupted');

    const records = await children.listChildren('parent');
    expect(records.map((record) => [record.childConversationId, record.state])).toEqual([
      ['child-reachable', 'stopped'],
      ['child-unreachable', 'lost'],
    ]);
    expect(stopped).toEqual(['child-reachable:parent-stopped']);

    // Order, not a stopwatch: the parent's durable terminal precedes every
    // child's stop record, and every child carries a measured duration.
    const childStates = (
      await durable.store.readEvents({ conversationId: 'child-reachable', limit: 20 })
    ).items.filter((event) => event.kind === 'child/state');
    const lostStates = (
      await durable.store.readEvents({ conversationId: 'child-unreachable', limit: 20 })
    ).items.filter((event) => event.kind === 'child/state');
    // Only the last state of each child is the cascade's; earlier ones are the
    // spawn itself and predate the parent's run.
    const stoppedEvent = childStates.at(-1);
    const lostEvent = lostStates.at(-1);
    for (const event of [stoppedEvent, lostEvent]) {
      expect(new Date(event?.occurredAt ?? 0).getTime()).toBeGreaterThanOrEqual(
        new Date(result.run.updatedAt).getTime(),
      );
      expect(JSON.stringify(event?.payload)).toContain('stopDurationMs');
    }
    expect(stoppedEvent?.payload).toMatchObject({ state: 'stopped' });
    expect(lostEvent?.payload).toMatchObject({ state: 'lost' });
    await runtime.close();
    await durable.close();
  });

  test('a superseded parent leaves its children to the conversation', async () => {
    const database = sqlite();
    const durable = createSqliteAgentRuntimeStore({ database });
    const stopped: string[] = [];
    const children = createAgentChildManager({
      remainingBudget: () => ({}),
      maxActiveChildren: 8,
      store: durable.store,
      host: durable.host,
      spawn: () => ({
        result: new Promise(() => undefined),
        stopPolicy: (name) => {
          stopped.push(name);
        },
      }),
    });
    await children.spawnChild({
      parentConversationId: 'parent',
      childConversationId: 'child',
      childInput: {},
      budget: { tokens: 1_000 },
    });
    const release = Promise.withResolvers<void>();
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store: durable.store,
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'test',
            modelId: 'blocked',
            contextWindow: 8_000,
            capabilities: [],
          },
          model: blockedModel(release.promise),
        }),
      },
      prompt: () => ({
        instructions: 'wait',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({}),
      children,
    });
    const ticket = runtime.submit({
      conversationId: 'parent',
      idempotencyKey: 'parent-input',
      context: {},
      parts: [{ type: 'text', text: 'go' }],
    });
    await ticket.accepted;
    await new Promise((resolve) => setTimeout(resolve, 20));
    // A successor takes the conversation over: the children stay its children.
    expect(runtime.stop('parent', 'supersede')).toBeTrue();
    release.resolve();
    const result = await ticket.result;
    expect(result.reason).toBe('superseded');
    expect((await children.listChildren('parent')).map((record) => record.state)).toEqual([
      'running',
    ]);
    expect(stopped).toEqual([]);
    await runtime.close();
    await durable.close();
  });

  test('stopChild records lost when stopPolicy times out, throws, or rejects, and when reachable throws or rejects', async () => {
    const database = sqlite();
    const durable = createSqliteAgentRuntimeStore({ database });
    const unexpectedStops: string[] = [];
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
      let tick = 1_700_000_000_000;
      const children = createAgentChildManager({
        remainingBudget: () => ({}),
        maxActiveChildren: 8,
        store: durable.store,
        host: durable.host,
        now: () => {
          tick += 1_000;
          return new Date(tick);
        },
        spawn: ({ childConversationId }) => {
          if (childConversationId === 'child-timeout') {
            return {
              result: new Promise(() => undefined),
              stopPolicy: () => new Promise(() => undefined),
            };
          }
          if (childConversationId === 'child-sync-throw') {
            return {
              result: new Promise(() => undefined),
              stopPolicy: () => {
                throw new Error('sync stop failed');
              },
            };
          }
          if (childConversationId === 'child-async-reject') {
            return {
              result: new Promise(() => undefined),
              stopPolicy: async () => {
                throw new Error('async stop failed');
              },
            };
          }
          if (childConversationId === 'child-reach-sync-throw') {
            return {
              result: new Promise(() => undefined),
              reachable: () => {
                throw new Error('sync probe failed');
              },
              stopPolicy: () => {
                unexpectedStops.push(childConversationId);
              },
            };
          }
          return {
            result: new Promise(() => undefined),
            reachable: async () => {
              throw new Error('async probe failed');
            },
            stopPolicy: () => {
              unexpectedStops.push(childConversationId);
            },
          };
        },
      });
      const ids = [
        'child-timeout',
        'child-sync-throw',
        'child-async-reject',
        'child-reach-sync-throw',
        'child-reach-async-reject',
      ];
      for (const childConversationId of ids) {
        await children.spawnChild({
          parentConversationId: 'parent',
          childConversationId,
          childInput: {},
          budget: { tokens: 100 },
        });
      }

      await children.stopChildren('parent');

      const records = await children.listChildren('parent');
      expect(records.map((record) => [record.childConversationId, record.state])).toEqual(
        ids.map((id) => [id, 'lost']),
      );
      expect(unexpectedStops).toEqual([]);
    } finally {
      timerSpy.mockRestore();
      await durable.close();
    }
  });

  test('interruptChild re-checks live state so a child that finishes during stopPolicy keeps finished and its result', async () => {
    const database = sqlite();
    const durable = createSqliteAgentRuntimeStore({ database });
    const result = Promise.withResolvers<{ resultReference?: string }>();
    try {
      const children = createAgentChildManager({
        remainingBudget: () => ({}),
        maxActiveChildren: 8,
        store: durable.store,
        host: durable.host,
        spawn: () => ({
          result: result.promise,
          stopPolicy: async () => {
            result.resolve({ resultReference: 'raced-answer' });
            await children.waitChild('child-race');
          },
        }),
      });
      await children.spawnChild({
        parentConversationId: 'parent',
        childConversationId: 'child-race',
        childInput: {},
        budget: { tokens: 100 },
      });

      await children.interruptChild('parent', 'child-race');

      const records = await children.listChildren('parent');
      expect(records.map((record) => [record.state, record.resultReference])).toEqual([
        ['finished', 'raced-answer'],
      ]);
    } finally {
      await durable.close();
    }
  });
});
