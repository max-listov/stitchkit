import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  createAgentRuntime,
  createSqliteAgentChildManager,
  defineAgentProtocol,
} from '../src/agent-runtime';
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
    const children = createSqliteAgentChildManager({
      sqlite: durable,
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

    const records = children.listChildren('parent');
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
    const children = createSqliteAgentChildManager({
      sqlite: durable,
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
    expect(children.listChildren('parent').map((record) => record.state)).toEqual(['running']);
    expect(stopped).toEqual([]);
    await runtime.close();
    await durable.close();
  });
});
