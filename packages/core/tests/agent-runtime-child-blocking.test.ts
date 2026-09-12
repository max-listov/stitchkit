import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createSqliteAgentChildManager } from '../src/agent-runtime';
import type {
  AgentChildBlockingDecision,
  AgentChildBlockingSource,
} from '../src/agent-runtime/children';
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

/**
 * A child host stand-in: it keeps the parent-owned bridge closures a real host
 * would wire to its child harness (`pendingApprovals` / `respondToApproval`).
 */
function fakeChild(initial: readonly AgentChildBlockingSource[]) {
  const reported = new Map<string, AgentChildBlockingSource>();
  for (const source of initial) reported.set(source.approvalId, source);
  const answered: AgentChildBlockingDecision[] = [];
  return {
    answered,
    handle: {
      result: new Promise<{ resultReference?: string }>(() => undefined),
      stopPolicy: () => undefined,
      blockingEvents: () => [...reported.values()],
      respondToBlocking: (decision: AgentChildBlockingDecision) => {
        answered.push(decision);
        reported.delete(decision.approvalId);
      },
    },
  };
}

async function actionsOn(
  durable: ReturnType<typeof createSqliteAgentRuntimeStore>,
  conversationId: string,
): Promise<string[]> {
  const page = await durable.store.readEvents({ conversationId, limit: 100 });
  return page.items
    .filter((event) => event.kind === 'child/state')
    .map((event) => (event.payload as { action?: string }).action)
    .filter((action): action is string => action !== undefined);
}

describe('the parent owns a child blocking event', () => {
  test('input responses carry JSON values and cannot be answered as approvals', async () => {
    const durable = createSqliteAgentRuntimeStore({ database: sqlite() });
    const child = fakeChild([
      {
        approvalId: 'question',
        callId: 'ask',
        toolName: 'ask',
        input: { prompt: 'Choose' },
        kind: 'input',
      },
    ]);
    const manager = createSqliteAgentChildManager({
      sqlite: durable,
      spawn: () => child.handle,
    });
    try {
      await manager.spawnChild({
        parentConversationId: 'parent',
        childConversationId: 'child',
        childInput: {},
        budget: { tokens: 10 },
      });
      const [request] = await manager.listChildBlocking('parent');
      if (!request) throw new Error('missing input request');
      await expect(
        manager.respondToChildBlocking('parent', {
          approvalId: request.approvalId,
          approved: true,
        }),
      ).rejects.toThrow('kind does not match');
      expect(child.answered).toHaveLength(0);
      await manager.respondToChildBlocking('parent', {
        approvalId: request.approvalId,
        value: { choice: 'blue' },
      });
      expect(child.answered).toEqual([{ approvalId: 'question', value: { choice: 'blue' } }]);
      expect(await manager.listChildBlocking('parent')).toEqual([]);
    } finally {
      await durable.close();
    }
  });
  /**
   * ADR 0179: a child's approval or input request is presented on the parent
   * exactly once, answered by the parent, and routed back to the child. The
   * child's own channel never carries a second presentation. This is the
   * invariant the relay enforces; the host wires the handle closures to its
   * child harness.
   */
  test('presented once on the parent, absent from the child, then answered back', async () => {
    const database = sqlite();
    const durable = createSqliteAgentRuntimeStore({ database });
    const child = fakeChild([
      {
        approvalId: 'approval-1',
        callId: 'call-1',
        toolName: 'write_file',
        input: { path: 'a.txt' },
        kind: 'approval',
      },
    ]);
    const manager = createSqliteAgentChildManager({
      sqlite: durable,
      spawn: () => child.handle,
    });
    await manager.spawnChild({
      parentConversationId: 'parent',
      childConversationId: 'child',
      childInput: { task: 'write' },
      budget: { tokens: 100 },
    });

    const first = await manager.listChildBlocking('parent');
    expect(first).toHaveLength(1);
    const event = first[0];
    if (!event) throw new Error('blocking event missing');
    expect(event).toMatchObject({
      parentConversationId: 'parent',
      childConversationId: 'child',
      approvalId: 'child:approval-1',
      childApprovalId: 'approval-1',
      callId: 'call-1',
      toolName: 'write_file',
      kind: 'approval',
    });
    expect(await actionsOn(durable, 'parent')).toEqual(['blocking-presented']);
    // The child channel must not carry a second presentation.
    expect(await actionsOn(durable, 'child')).toEqual([]);

    // Polling again is idempotent: still one pending, still one presentation.
    const second = await manager.listChildBlocking('parent');
    expect(second.map((candidate) => candidate.approvalId)).toEqual(['child:approval-1']);
    expect(await actionsOn(durable, 'parent')).toEqual(['blocking-presented']);

    await manager.respondToChildBlocking('parent', {
      approvalId: 'child:approval-1',
      approved: true,
      reason: 'looks fine',
    });
    // The child harness received the child-local id, not the parent-scoped one.
    expect(child.answered).toEqual([
      { approvalId: 'approval-1', approved: true, reason: 'looks fine' },
    ]);
    expect(await manager.listChildBlocking('parent')).toEqual([]);
    expect(await actionsOn(durable, 'parent')).toEqual([
      'blocking-presented',
      'blocking-resolved',
    ]);
    expect(await actionsOn(durable, 'child')).toEqual([]);

    // A stale second answer cannot route.
    await expect(
      manager.respondToChildBlocking('parent', {
        approvalId: 'child:approval-1',
        approved: true,
      }),
    ).rejects.toThrow('missing, stale or already answered');
    expect(child.answered).toHaveLength(1);
    await durable.close();
  });

  test('answering one request preserves unresolved siblings even in an explicit batch', async () => {
    const database = sqlite();
    const durable = createSqliteAgentRuntimeStore({ database });
    const child = fakeChild([
      {
        approvalId: 'approval-a',
        callId: 'call-a',
        toolName: 'write_file',
        input: { path: 'a.txt' },
        kind: 'approval',
        batchId: 'message-9',
      },
      {
        approvalId: 'approval-b',
        callId: 'call-b',
        toolName: 'write_file',
        input: { path: 'b.txt' },
        kind: 'approval',
        batchId: 'message-9',
      },
    ]);
    const manager = createSqliteAgentChildManager({
      sqlite: durable,
      spawn: () => child.handle,
    });
    await manager.spawnChild({
      parentConversationId: 'parent',
      childConversationId: 'child',
      childInput: { task: 'write' },
      budget: { tokens: 100 },
    });

    const presented = await manager.listChildBlocking('parent');
    expect(presented.map((event) => event.approvalId).sort()).toEqual([
      'child:approval-a',
      'child:approval-b',
    ]);
    expect(await actionsOn(durable, 'parent')).toEqual([
      'blocking-presented',
      'blocking-presented',
    ]);

    await manager.respondToChildBlocking('parent', {
      approvalId: 'child:approval-a',
      approved: false,
    });
    expect(
      (await manager.listChildBlocking('parent')).map((event) => event.childApprovalId),
    ).toEqual(['approval-b']);
    await manager.respondToChildBlocking('parent', {
      approvalId: 'child:approval-b',
      approved: true,
    });
    expect(await manager.listChildBlocking('parent')).toEqual([]);
    expect(child.answered).toEqual([
      { approvalId: 'approval-a', approved: false },
      { approvalId: 'approval-b', approved: true },
    ]);
    await durable.close();
  });

  test('an unknown or foreign request id is refused without touching the child', async () => {
    const database = sqlite();
    const durable = createSqliteAgentRuntimeStore({ database });
    const child = fakeChild([
      {
        approvalId: 'approval-1',
        callId: 'call-1',
        toolName: 'write_file',
        input: {},
        kind: 'approval',
      },
    ]);
    const manager = createSqliteAgentChildManager({
      sqlite: durable,
      spawn: () => child.handle,
    });
    await manager.spawnChild({
      parentConversationId: 'parent',
      childConversationId: 'child',
      childInput: {},
      budget: { tokens: 100 },
    });
    await manager.listChildBlocking('parent');

    await expect(
      manager.respondToChildBlocking('parent', {
        approvalId: 'child:not-a-request',
        approved: true,
      }),
    ).rejects.toThrow('missing, stale or already answered');
    // A parent that never presented the request cannot answer it.
    await expect(
      manager.respondToChildBlocking('other-parent', {
        approvalId: 'child:approval-1',
        approved: true,
      }),
    ).rejects.toThrow('missing, stale or already answered');
    expect(child.answered).toEqual([]);
    await durable.close();
  });

  test('a stale child report after resolution is not presented again', async () => {
    const database = sqlite();
    const durable = createSqliteAgentRuntimeStore({ database });
    // A host that never clears its child harness view: the same request stays
    // reported after the parent answers it. The relay must not re-present it.
    const stale: AgentChildBlockingSource = {
      approvalId: 'approval-1',
      callId: 'call-1',
      toolName: 'write_file',
      input: {},
      kind: 'approval',
    };
    const manager = createSqliteAgentChildManager({
      sqlite: durable,
      spawn: () => ({
        result: new Promise<{ resultReference?: string }>(() => undefined),
        stopPolicy: () => undefined,
        blockingEvents: () => [stale],
        respondToBlocking: () => undefined,
      }),
    });
    await manager.spawnChild({
      parentConversationId: 'parent',
      childConversationId: 'child',
      childInput: {},
      budget: { tokens: 100 },
    });
    const first = await manager.listChildBlocking('parent');
    expect(first).toHaveLength(1);
    await manager.respondToChildBlocking('parent', {
      approvalId: 'child:approval-1',
      approved: true,
    });
    expect(await manager.listChildBlocking('parent')).toEqual([]);
    expect(
      (await actionsOn(durable, 'parent')).filter((action) => action === 'blocking-presented'),
    ).toEqual(['blocking-presented']);
    await durable.close();
  });

  test('stopping a child retires its pending presentation', async () => {
    const database = sqlite();
    const durable = createSqliteAgentRuntimeStore({ database });
    const child = fakeChild([
      {
        approvalId: 'approval-1',
        callId: 'call-1',
        toolName: 'write_file',
        input: {},
        kind: 'approval',
      },
    ]);
    const manager = createSqliteAgentChildManager({
      sqlite: durable,
      spawn: () => child.handle,
    });
    await manager.spawnChild({
      parentConversationId: 'parent',
      childConversationId: 'child',
      childInput: {},
      budget: { tokens: 100 },
    });
    await manager.listChildBlocking('parent');
    await manager.stopChildren('parent');
    expect(await manager.listChildBlocking('parent')).toEqual([]);
    await expect(
      manager.respondToChildBlocking('parent', {
        approvalId: 'child:approval-1',
        approved: true,
      }),
    ).rejects.toThrow('missing, stale or already answered');
    await durable.close();
  });

  test('one parent never sees another parent pending child request', async () => {
    const database = sqlite();
    const durable = createSqliteAgentRuntimeStore({ database });
    const childA = fakeChild([
      {
        approvalId: 'approval-a',
        callId: 'call-a',
        toolName: 'write_file',
        input: { path: 'a.txt' },
        kind: 'approval',
      },
    ]);
    const childB = fakeChild([
      {
        approvalId: 'approval-b',
        callId: 'call-b',
        toolName: 'delete_file',
        input: { path: 'b.txt' },
        kind: 'approval',
      },
    ]);
    const manager = createSqliteAgentChildManager({
      sqlite: durable,
      spawn: ({ childConversationId }) =>
        childConversationId === 'child-a' ? childA.handle : childB.handle,
    });
    await manager.spawnChild({
      parentConversationId: 'parent-a',
      childConversationId: 'child-a',
      childInput: {},
      budget: { tokens: 100 },
    });
    await manager.spawnChild({
      parentConversationId: 'parent-b',
      childConversationId: 'child-b',
      childInput: {},
      budget: { tokens: 100 },
    });

    // Present on each parent's own channel; both requests are pending globally.
    await manager.listChildBlocking('parent-a');
    await manager.listChildBlocking('parent-b');

    const forA = await manager.listChildBlocking('parent-a');
    expect(forA.map((event) => event.approvalId)).toEqual(['child-a:approval-a']);
    expect(forA.every((event) => event.parentConversationId === 'parent-a')).toBe(true);
    expect(JSON.stringify(forA)).not.toContain('delete_file');
    expect(JSON.stringify(forA)).not.toContain('b.txt');

    const forB = await manager.listChildBlocking('parent-b');
    expect(forB.map((event) => event.approvalId)).toEqual(['child-b:approval-b']);
    expect(forB.every((event) => event.parentConversationId === 'parent-b')).toBe(true);
    expect(JSON.stringify(forB)).not.toContain('write_file');
    expect(JSON.stringify(forB)).not.toContain('a.txt');

    await durable.close();
  });
});
