import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { AgentMessageSchema, AgentRunSchema } from 'stitchkit/agent-runtime';
import { runAgentStoreConformance } from 'stitchkit/testing';
import { createPrismaAgentStoreFixture } from './adapter';

const connectionString = process.env.AGENT_STORE_DATABASE_URL;
if (connectionString && !new URL(connectionString).pathname.startsWith('/sk_lane_')) {
  throw new Error('Prisma agent-store proof refuses a non-disposable database');
}
const fixture = connectionString
  ? createPrismaAgentStoreFixture({ connectionString })
  : undefined;

describe.skipIf(!fixture)('Prisma/PostgreSQL agent store reference', () => {
  beforeEach(async () => {
    await fixture?.prisma.agentRuntimeMessage.deleteMany();
    await fixture?.prisma.agentRuntimeAdmission.deleteMany();
    await fixture?.prisma.agentRuntimeRun.deleteMany();
    await fixture?.prisma.agentRuntimeState.deleteMany();
  });

  afterAll(async () => {
    await fixture?.prisma.$disconnect();
  });

  test('passes the reusable store conformance contract', async () => {
    if (!fixture) return;
    await runAgentStoreConformance({ createStore: () => fixture.store });
  });

  test('rolls state CAS back when history persistence fails', async () => {
    if (!connectionString || !fixture) return;
    const failing = createPrismaAgentStoreFixture({
      connectionString,
      failAfterHistoryApply: true,
    });
    const input = AgentMessageSchema.parse({
      schemaVersion: 1,
      id: 'rollback-input',
      conversationId: 'rollback-conversation',
      role: 'user',
      status: 'committed',
      parts: [{ type: 'text', text: 'rollback' }],
      createdAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:00.000Z',
    });
    const run = AgentRunSchema.parse({
      schemaVersion: 1,
      id: 'rollback-run',
      conversationId: input.conversationId,
      inputMessageIds: [input.id],
      assistantMessageId: 'rollback-assistant',
      state: 'queued',
      revision: 0,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    });
    await expect(
      failing.store.acceptInputAndAssignRun({
        idempotencyKey: 'rollback-request',
        input,
        run,
      }),
    ).rejects.toThrow('Injected failure');
    await failing.prisma.$disconnect();
    expect(await fixture.store.loadSnapshot(input.conversationId)).toMatchObject({
      version: 0,
      messages: [],
      runs: [],
    });
  });

  test('serializes competing admissions into one winner and one durable duplicate', async () => {
    if (!fixture) return;
    const makeAssignment = (suffix: string) => {
      const input = AgentMessageSchema.parse({
        schemaVersion: 1,
        id: `race-input-${suffix}`,
        conversationId: 'race-conversation',
        role: 'user',
        status: 'committed',
        parts: [{ type: 'text', text: suffix }],
        createdAt: '2026-08-22T00:00:00.000Z',
        updatedAt: '2026-08-22T00:00:00.000Z',
      });
      return {
        idempotencyKey: 'race-request',
        input,
        run: AgentRunSchema.parse({
          schemaVersion: 1,
          id: `race-run-${suffix}`,
          conversationId: input.conversationId,
          inputMessageIds: [input.id],
          assistantMessageId: `race-assistant-${suffix}`,
          state: 'queued',
          revision: 0,
          createdAt: input.createdAt,
          updatedAt: input.updatedAt,
        }),
      };
    };
    const results = await Promise.all([
      fixture.store.acceptInputAndAssignRun(makeAssignment('a')),
      fixture.store.acceptInputAndAssignRun(makeAssignment('b')),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual(['applied', 'duplicate']);
    const snapshot = await fixture.store.loadSnapshot('race-conversation');
    expect(snapshot).toMatchObject({ version: 1 });
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.runs).toHaveLength(1);
  });

  test('serializes a terminal race and reports the current run revision', async () => {
    if (!connectionString || !fixture) return;
    const input = AgentMessageSchema.parse({
      schemaVersion: 1,
      id: 'terminal-input',
      conversationId: 'terminal-race',
      role: 'user',
      status: 'committed',
      parts: [{ type: 'text', text: 'race' }],
      createdAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:00.000Z',
    });
    const admitted = await fixture.store.acceptInputAndAssignRun({
      idempotencyKey: 'terminal-request',
      input,
      run: AgentRunSchema.parse({
        schemaVersion: 1,
        id: 'terminal-run',
        conversationId: input.conversationId,
        inputMessageIds: [input.id],
        assistantMessageId: 'terminal-assistant',
        state: 'queued',
        revision: 0,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      }),
    });
    if (admitted.outcome !== 'applied') throw new Error('fixture admission failed');
    const acquired = await fixture.store.acquireRun({
      conversationId: input.conversationId,
      runId: 'terminal-run',
      expectedRevision: 0,
      ownerId: 'terminal-owner',
    });
    if (acquired.outcome !== 'applied') throw new Error('fixture acquisition failed');
    const competing = createPrismaAgentStoreFixture({ connectionString });
    const terminal = {
      conversationId: input.conversationId,
      runId: 'terminal-run',
      expectedRevision: 1,
      ownerId: 'terminal-owner',
      reason: 'success',
      assistant: AgentMessageSchema.parse({
        schemaVersion: 1,
        id: 'terminal-assistant',
        conversationId: input.conversationId,
        runId: 'terminal-run',
        role: 'assistant',
        status: 'completed',
        parts: [{ type: 'text', text: 'done' }],
        createdAt: input.createdAt,
        updatedAt: '2026-08-22T00:00:01.000Z',
      }),
    } satisfies Parameters<typeof fixture.store.commitRunTerminal>[0];
    const results = await Promise.all([
      fixture.store.commitRunTerminal(terminal),
      competing.store.commitRunTerminal(terminal),
    ]);
    await competing.prisma.$disconnect();
    expect(results.map((result) => result.outcome).sort()).toEqual(['applied', 'conflict']);
    expect(results.find((result) => result.outcome === 'conflict')).toMatchObject({
      actualVersion: 2,
    });
  });

  test('rolls compaction history and state back together', async () => {
    if (!connectionString || !fixture) return;
    const conversationId = 'compaction-rollback';
    for (const suffix of ['a', 'b']) {
      const input = AgentMessageSchema.parse({
        schemaVersion: 1,
        id: `compact-input-${suffix}`,
        conversationId,
        role: 'user',
        status: 'committed',
        parts: [{ type: 'text', text: suffix }],
        createdAt: '2026-08-22T00:00:00.000Z',
        updatedAt: '2026-08-22T00:00:00.000Z',
      });
      await fixture.store.acceptInputAndAssignRun({
        idempotencyKey: `compact-${suffix}`,
        input,
        run: AgentRunSchema.parse({
          schemaVersion: 1,
          id: `compact-run-${suffix}`,
          conversationId,
          inputMessageIds: [input.id],
          assistantMessageId: `compact-assistant-${suffix}`,
          state: 'queued',
          revision: 0,
          createdAt: input.createdAt,
          updatedAt: input.updatedAt,
        }),
      });
    }
    const before = await fixture.store.loadSnapshot(conversationId);
    const failing = createPrismaAgentStoreFixture({
      connectionString,
      failAfterHistoryApply: true,
    });
    await expect(
      failing.store.replaceCompactedRange({
        conversationId,
        expectedVersion: before.version,
        replacedMessageIds: ['compact-input-a', 'compact-input-b'],
        summary: AgentMessageSchema.parse({
          schemaVersion: 1,
          id: 'compact-summary',
          conversationId,
          role: 'summary',
          status: 'committed',
          parts: [{ type: 'text', text: 'summary' }],
          createdAt: '2026-08-22T00:00:01.000Z',
          updatedAt: '2026-08-22T00:00:01.000Z',
        }),
      }),
    ).rejects.toThrow('Injected failure');
    await failing.prisma.$disconnect();
    expect(await fixture.store.loadSnapshot(conversationId)).toEqual(before);
  });

  test('reconstructs bounded recovery after a fresh adapter process', async () => {
    if (!connectionString || !fixture) return;
    const conversationId = 'restart\u0000conversation';
    const input = AgentMessageSchema.parse({
      schemaVersion: 1,
      id: 'restart\u0000input',
      conversationId,
      role: 'user',
      status: 'committed',
      parts: [{ type: 'text', text: 'restart' }],
      createdAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:00.000Z',
    });
    await fixture.store.acceptInputAndAssignRun({
      idempotencyKey: 'restart-request',
      input,
      run: AgentRunSchema.parse({
        schemaVersion: 1,
        id: 'restart\u0000run',
        conversationId,
        inputMessageIds: [input.id],
        assistantMessageId: 'restart\u0000assistant',
        state: 'queued',
        revision: 0,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      }),
    });
    const restarted = createPrismaAgentStoreFixture({ connectionString });
    const page = await restarted.store.scanRecoverablePage?.({ limit: 1 });
    expect(page).toMatchObject({
      items: [{ conversationId, run: { id: 'restart\u0000run', state: 'queued' } }],
    });
    expect(await restarted.store.loadSnapshot(conversationId)).toMatchObject({
      messages: [{ id: 'restart\u0000input' }],
      runs: [{ id: 'restart\u0000run' }],
    });
    await restarted.prisma.$disconnect();
  });

  test('keeps the runtime head constant-size across a long compacted conversation', async () => {
    if (!fixture) return;
    const conversationId = 'bounded-conversation';
    let previousSummaryId: string | undefined;
    for (let index = 0; index < 64; index += 1) {
      const createdAt = new Date(Date.UTC(2026, 7, 23, 0, 0, index)).toISOString();
      const input = AgentMessageSchema.parse({
        schemaVersion: 1,
        id: `bounded-input-${index}`,
        conversationId,
        role: 'user',
        status: 'committed',
        parts: [{ type: 'text', text: `${index}` }],
        createdAt,
        updatedAt: createdAt,
      });
      const run = AgentRunSchema.parse({
        schemaVersion: 1,
        id: `bounded-run-${index}`,
        conversationId,
        inputMessageIds: [input.id],
        assistantMessageId: `bounded-assistant-${index}`,
        state: 'queued',
        revision: 0,
        createdAt,
        updatedAt: createdAt,
      });
      const admitted = await fixture.store.acceptInputAndAssignRun({
        idempotencyKey: `bounded-request-${index}`,
        input,
        run,
      });
      if (admitted.outcome !== 'applied') throw new Error('bounded admission failed');
      const acquired = await fixture.store.acquireRun({
        conversationId,
        runId: run.id,
        expectedRevision: 0,
        ownerId: 'bounded-owner',
      });
      if (acquired.outcome !== 'applied') throw new Error('bounded acquisition failed');
      const terminal = await fixture.store.commitRunTerminal({
        conversationId,
        runId: run.id,
        expectedRevision: 1,
        ownerId: 'bounded-owner',
        reason: 'success',
        assistant: AgentMessageSchema.parse({
          schemaVersion: 1,
          id: run.assistantMessageId,
          conversationId,
          runId: run.id,
          role: 'assistant',
          status: 'completed',
          parts: [{ type: 'text', text: `done-${index}` }],
          createdAt,
          updatedAt: createdAt,
        }),
      });
      if (terminal.outcome !== 'applied') throw new Error('bounded terminal failed');
      const summaryId = `bounded-summary-${index}`;
      const compacted = await fixture.store.replaceCompactedRange({
        conversationId,
        expectedVersion: terminal.snapshot.version,
        replacedMessageIds: [
          ...(previousSummaryId ? [previousSummaryId] : []),
          input.id,
          run.assistantMessageId,
        ],
        summary: AgentMessageSchema.parse({
          schemaVersion: 1,
          id: summaryId,
          conversationId,
          role: 'summary',
          status: 'committed',
          parts: [{ type: 'text', text: `through-${index}` }],
          createdAt,
          updatedAt: createdAt,
        }),
      });
      if (compacted.outcome !== 'applied') throw new Error('bounded compaction failed');
      previousSummaryId = summaryId;
    }

    const conversationStorageId = Buffer.from(conversationId, 'utf8').toString('base64url');
    const [head, runCount, admissionCount, activeHistoryCount, recoverableCount] =
      await Promise.all([
        fixture.prisma.agentRuntimeState.findUnique({
          where: { conversationId: conversationStorageId },
        }),
        fixture.prisma.agentRuntimeRun.count({
          where: { conversationId: conversationStorageId },
        }),
        fixture.prisma.agentRuntimeAdmission.count({
          where: { conversationId: conversationStorageId },
        }),
        fixture.prisma.agentRuntimeMessage.count({
          where: { conversationId: conversationStorageId, active: true },
        }),
        fixture.prisma.agentRuntimeRun.count({
          where: {
            conversationId: conversationStorageId,
            state: { in: ['queued', 'running', 'interrupt_requested'] },
          },
        }),
      ]);
    expect(head).toEqual({ conversationId: conversationStorageId, version: 256 });
    expect({ runCount, admissionCount, activeHistoryCount, recoverableCount }).toEqual({
      runCount: 64,
      admissionCount: 64,
      activeHistoryCount: 1,
      recoverableCount: 0,
    });
  });
});
