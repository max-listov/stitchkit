/**
 * The blocking relay on a child that does not answer, and what it keeps.
 *
 * Each live child is asked for its blocking events within the stop bound; a
 * child that does not answer, throws, rejects or reports a malformed request
 * is named as unavailable, and its siblings are still presented. What the
 * relay remembers about a child's requests is forgotten when the child ends.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { createChildBlockingRelay } from '../src/agent-runtime/child-blocking';
import type {
  AgentChildBlockingSource,
  AgentChildHandle,
} from '../src/agent-runtime/children';
import { createAgentChildManager } from '../src/agent-runtime/children';
import { spawnChild } from '../src/agent-runtime/children-spawn';
import {
  activeChild,
  bounded,
  createChildManagerState,
  listChildren,
} from '../src/agent-runtime/children-state';
import { createBunSqliteAgentRuntimeStore } from '../src/agent-runtime/sqlite-bun';
import {
  type AgentChildManager,
  type AgentRuntimeStore,
  createAgentChildManager as createPublicChildManager,
} from '../src/entrypoints/agent-runtime';

const request = (approvalId: string): AgentChildBlockingSource => ({
  approvalId,
  callId: `call-${approvalId}`,
  toolName: 'write_file',
  input: {},
  kind: 'approval',
});

/** The stop bound, made short: every `setTimeout(…, 10_000)` fires after `ms` (10 ms). */
function fastStopBound(ms = 10) {
  const realSetTimeout = globalThis.setTimeout;
  const fast = new Proxy(realSetTimeout, {
    apply: (target, thisArg, args: unknown[]) =>
      Reflect.apply(target, thisArg, [
        args[0],
        args[1] === 10_000 ? ms : args[1],
        ...args.slice(2),
      ]),
  });
  return spyOn(globalThis, 'setTimeout').mockImplementation(fast);
}

describe('a child that cannot say what it has pending', () => {
  test('a timeout, a throw, a rejection and a malformed report each name the child as unavailable', async () => {
    const owner = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    const timer = fastStopBound();
    const blockingEvents: Record<string, AgentChildHandle['blockingEvents']> = {
      answers: () => [request('ok')],
      hangs: () => new Promise(() => undefined),
      throws: () => {
        throw new Error('host refused');
      },
      rejects: async () => {
        throw new Error('host failed');
      },
      // An untyped host: what it reports is read as data, not trusted as a source.
      malformed: () => JSON.parse('[{ "approvalId": "" }]'),
    };
    try {
      const manager = createAgentChildManager({
        remainingBudget: () => ({}),
        maxActiveChildren: 8,
        store: owner.store,
        host: owner.host,
        spawn: ({ childConversationId }) => ({
          result: new Promise(() => undefined),
          stopPolicy: () => undefined,
          ...(blockingEvents[childConversationId] && {
            blockingEvents: blockingEvents[childConversationId],
          }),
        }),
      });
      for (const childConversationId of Object.keys(blockingEvents)) {
        await manager.spawnChild({
          parentConversationId: 'parent',
          childConversationId,
          childInput: {},
          budget: { tokens: 10 },
        });
      }
      const listed = await manager.listChildBlocking('parent');
      expect(listed.pending.map((event) => event.approvalId)).toEqual(['answers:ok']);
      const unavailable = new Map(
        listed.unavailable.map((entry) => [entry.childConversationId, entry]),
      );
      expect([...unavailable.keys()].sort()).toEqual([
        'hangs',
        'malformed',
        'rejects',
        'throws',
      ]);
      expect(unavailable.get('hangs')).toEqual({
        childConversationId: 'hangs',
        reason: 'timeout',
      });
      const cause = (id: string) => {
        const entry = unavailable.get(id);
        return entry?.reason === 'failed' ? String(entry.cause) : undefined;
      };
      expect(cause('throws')).toContain('host refused');
      expect(cause('rejects')).toContain('host failed');
      expect(cause('malformed')).toContain('approvalId');
    } finally {
      timer.mockRestore();
      await owner.close();
    }
  });
});

describe('what the relay keeps about a child', () => {
  test('answered and presented requests are forgotten when the child ends', async () => {
    const owner = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    const result = Promise.withResolvers<{ resultReference?: string }>();
    const reported = new Map([
      ['one', request('one')],
      ['two', request('two')],
    ]);
    try {
      const state = createChildManagerState({
        remainingBudget: () => ({}),
        maxActiveChildren: 8,
        store: owner.store,
        host: owner.host,
        spawn: () => ({
          result: result.promise,
          stopPolicy: () => undefined,
          // A child that keeps reporting what was already answered.
          blockingEvents: () => [...reported.values()],
          respondToBlocking: () => undefined,
        }),
      });
      const relay = createChildBlockingRelay({
        store: state.store,
        now: state.now,
        handles: state.handles,
        listChildren: (id) => listChildren(state, id),
        activeChild: (parent, child) => activeChild(state, parent, child),
        bounded,
      });
      await spawnChild(state, relay.retireChildBlocking, {
        parentConversationId: 'parent',
        childConversationId: 'child',
        childInput: {},
        budget: { tokens: 10 },
      });
      await relay.listChildBlocking('parent');
      await relay.respondToChildBlocking('parent', {
        approvalId: 'child:one',
        approved: true,
      });
      // The stale report of the answered request is not presented again.
      expect(
        (await relay.listChildBlocking('parent')).pending.map((event) => event.approvalId),
      ).toEqual(['child:two']);
      expect(relay.retained.presented.size).toBe(1);
      expect(relay.retained.retired.get('child')?.size).toBe(1);

      result.resolve({ resultReference: 'done' });
      await state.settlements.get('child')?.settled;
      expect(relay.retained.presented.size).toBe(0);
      expect(relay.retained.retired.size).toBe(0);
    } finally {
      await owner.close();
    }
  });
});

describe('a child host that never answers the parent', () => {
  async function hungHost(
    run: (manager: AgentChildManager, store: AgentRuntimeStore) => Promise<void>,
  ) {
    const owner = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    // Long enough that the other parent is served well inside it.
    const timer = fastStopBound(300);
    try {
      const manager = createPublicChildManager({
        remainingBudget: () => ({}),
        maxActiveChildren: 8,
        store: owner.store,
        host: owner.host,
        spawn: ({ childConversationId }) => ({
          result: new Promise(() => undefined),
          stopPolicy: () => undefined,
          blockingEvents: () => [request(`${childConversationId}-ask`)],
          // The first parent's child hangs on every answer; the second's answers.
          respondToBlocking: () =>
            childConversationId === 'hung' ? new Promise<void>(() => undefined) : undefined,
          sendMessage: () =>
            childConversationId === 'hung' ? new Promise<void>(() => undefined) : undefined,
        }),
      });
      for (const [parentConversationId, childConversationId] of [
        ['p1', 'hung'],
        ['p2', 'live'],
      ] as const) {
        await manager.spawnChild({
          parentConversationId,
          childConversationId,
          childInput: {},
          budget: { tokens: 10 },
        });
      }
      await run(manager, owner.store);
    } finally {
      timer.mockRestore();
      await owner.close();
    }
  }

  test("a hung answer ends at the bound and holds no other parent's blocking requests", async () => {
    await hungHost(async (manager) => {
      const [hung] = (await manager.listChildBlocking('p1')).pending;
      if (!hung) throw new Error('expected the hung child to present a request');
      const answering = manager.respondToChildBlocking('p1', {
        approvalId: hung.approvalId,
        approved: true,
      });
      let answered = false;
      const settled = answering
        .then(
          () => 'answered',
          (error: unknown) => String(error),
        )
        .finally(() => {
          answered = true;
        });
      // Another parent is served while the first one's host is still silent.
      const other = await Promise.race([
        manager.listChildBlocking('p2').then((listed) => listed.pending.length),
        Bun.sleep(2_000).then(() => 'still waiting'),
      ]);
      expect([other, answered]).toEqual([1, false]);
      expect(await settled).toContain('did not answer the blocking response within');
      // Not answered, so still presented: the parent can answer it again.
      expect(
        (await manager.listChildBlocking('p1')).pending.map((event) => event.approvalId),
      ).toEqual([hung.approvalId]);
    });
  });

  test('a hung message ends at the bound and is not journaled as sent', async () => {
    await hungHost(async (manager, store) => {
      const sent = manager.sendMessage('p1', 'hung', { text: 'ping' }).then(
        () => 'sent',
        (error: unknown) => String(error),
      );
      expect(
        await Promise.race([sent, Bun.sleep(2_000).then(() => 'still waiting')]),
      ).toContain('did not answer the message within');
      const actions = (await store.readEvents({ conversationId: 'p1', limit: 50 })).items.map(
        (event) => Reflect.get(Object(event.payload), 'action'),
      );
      expect(actions).not.toContain('message-sent');
    });
  });
});

describe('a child host that answers after the bound', () => {
  test('a late blocking answer is not answered twice and retires its request when it lands', async () => {
    const owner = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    const timer = fastStopBound();
    const late = Promise.withResolvers<void>();
    const answers: unknown[] = [];
    try {
      const manager = createPublicChildManager({
        remainingBudget: () => ({}),
        maxActiveChildren: 8,
        store: owner.store,
        host: owner.host,
        spawn: () => ({
          result: new Promise(() => undefined),
          stopPolicy: () => undefined,
          blockingEvents: () => [request('ask')],
          respondToBlocking: (decision) => {
            answers.push(decision);
            return late.promise;
          },
        }),
      });
      await manager.spawnChild({
        parentConversationId: 'p',
        childConversationId: 'c',
        childInput: {},
        budget: { tokens: 10 },
      });
      const [asked] = (await manager.listChildBlocking('p')).pending;
      if (!asked) throw new Error('expected a presented request');
      const answer = () =>
        manager.respondToChildBlocking('p', { approvalId: asked.approvalId, approved: true });
      await expect(answer()).rejects.toThrow('did not answer the blocking response within');
      // Its first answer may still land: a second one is refused, not sent.
      await expect(answer()).rejects.toThrow('an earlier answer is still with the child host');
      expect(answers).toHaveLength(1);
      late.resolve();
      await Bun.sleep(20);
      expect((await manager.listChildBlocking('p')).pending).toEqual([]);
      const actions = (
        await owner.store.readEvents({ conversationId: 'p', limit: 50 })
      ).items.map((event) => Reflect.get(Object(event.payload), 'action'));
      expect(actions).toContain('blocking-resolved');
    } finally {
      timer.mockRestore();
      await owner.close();
    }
  });

  test('a late message is not sent twice and is journaled when it lands', async () => {
    const owner = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    const timer = fastStopBound();
    const late = Promise.withResolvers<void>();
    const messages: unknown[] = [];
    try {
      const manager = createPublicChildManager({
        remainingBudget: () => ({}),
        maxActiveChildren: 8,
        store: owner.store,
        host: owner.host,
        spawn: () => ({
          result: new Promise(() => undefined),
          stopPolicy: () => undefined,
          sendMessage: (message) => {
            messages.push(message);
            return messages.length === 1 ? late.promise : undefined;
          },
        }),
      });
      await manager.spawnChild({
        parentConversationId: 'p',
        childConversationId: 'c',
        childInput: {},
        budget: { tokens: 10 },
      });
      await expect(manager.sendMessage('p', 'c', 'one')).rejects.toThrow(
        'did not answer the message within',
      );
      await expect(manager.sendMessage('p', 'c', 'two')).rejects.toThrow(
        'an earlier message is still with the child host',
      );
      late.resolve();
      await Bun.sleep(20);
      await manager.sendMessage('p', 'c', 'three');
      expect(messages).toEqual(['one', 'three']);
      const sent = (
        await owner.store.readEvents({ conversationId: 'p', limit: 50 })
      ).items.filter(
        (event) => Reflect.get(Object(event.payload), 'action') === 'message-sent',
      );
      expect(sent).toHaveLength(2);
    } finally {
      timer.mockRestore();
      await owner.close();
    }
  });
});

describe('round 7: late messages counted one by one', () => {
  test('two parallel messages that outlive the bound keep the guard until both settle', async () => {
    const owner = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    const timer = fastStopBound();
    const held = new Map<unknown, PromiseWithResolvers<void>>();
    try {
      const manager = createPublicChildManager({
        remainingBudget: () => ({}),
        maxActiveChildren: 8,
        store: owner.store,
        host: owner.host,
        spawn: () => ({
          result: new Promise(() => undefined),
          stopPolicy: () => undefined,
          sendMessage: (message) => {
            const delivery = Promise.withResolvers<void>();
            held.set(message, delivery);
            return message === 'three' ? undefined : delivery.promise;
          },
        }),
      });
      await manager.spawnChild({
        parentConversationId: 'p',
        childConversationId: 'c',
        childInput: {},
        budget: { tokens: 10 },
      });
      const outcomes = await Promise.allSettled([
        manager.sendMessage('p', 'c', 'one'),
        manager.sendMessage('p', 'c', 'two'),
      ]);
      expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);
      held.get('one')?.resolve();
      await Bun.sleep(20);
      // `two` is still with the host: a resend is refused, not delivered twice.
      await expect(manager.sendMessage('p', 'c', 'two')).rejects.toThrow(
        'an earlier message is still with the child host',
      );
      held.get('two')?.resolve();
      await Bun.sleep(20);
      await manager.sendMessage('p', 'c', 'three');
      expect([...held.keys()]).toEqual(['one', 'two', 'three']);
    } finally {
      timer.mockRestore();
      await owner.close();
    }
  });
});
