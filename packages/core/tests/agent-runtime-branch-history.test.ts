import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createBunSqliteAgentRuntimeStore } from '../src/agent-runtime/sqlite-bun';
import {
  type AgentConversationArchive,
  AgentMessageSchema,
  AgentRunSchema,
  createAgentScheduleService,
  createAgentStateSlotStore,
  createMemoryAgentRuntimeStore,
  defineStateSlot,
  encodeAgentConversationArchive,
} from '../src/entrypoints/agent-runtime';
import { createLocalStepDurability } from '../src/entrypoints/tools';
import { branch, branchInput, branchTime, branchTurn } from './support/agent-branch-fixture';

test('a migrated baseline retains inactive rows and exact active context in memory and SQLite', async () => {
  const sqlite = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
  try {
    const input = branchInput('source', 'input');
    const assistant = AgentMessageSchema.parse({
      ...branchInput('source', 'answer'),
      parts: [
        { type: 'tool-call', callId: 'baseline-call', toolName: 'run_command', input: {} },
        {
          type: 'tool-result',
          callId: 'baseline-call',
          toolName: 'run_command',
          outcome: 'success',
          output: {
            executable: 'fixture',
            exitCode: 0,
            signal: null,
            stdout: 'preview',
            stderr: '',
            outcome: 'exited',
            artifact: {
              reference: 'baseline-ref',
              bytes: 3,
              truncated: true,
              headBytes: 0,
              tailBytes: 0,
              omittedBytes: 3,
            },
          },
        },
      ],
      runId: 'run',
      role: 'assistant',
      status: 'completed',
    });
    const summary = AgentMessageSchema.parse({
      ...branchInput('source', 'summary'),
      role: 'summary',
    });
    const run = AgentRunSchema.parse({
      schemaVersion: 1,
      id: 'run',
      conversationId: 'source',
      inputMessageIds: ['input'],
      assistantMessageId: 'answer',
      state: 'completed',
      revision: 2,
      terminalReason: 'success',
      ownerId: 'old-owner',
      fencingToken: 1,
      createdAt: branchTime,
      updatedAt: branchTime,
    });
    const baseline = {
      migratedAt: branchTime,
      head: { schemaVersion: 1, conversationId: 'source', version: 4 },
      messages: [input, assistant, summary],
      compacted: ['input', 'answer'],
      runs: [{ schemaVersion: 1, run, terminalAssistant: assistant }],
      admissions: [
        {
          schemaVersion: 1,
          conversationId: 'source',
          idempotencyKey: 'input',
          input,
          runId: 'run',
          assistantMessageId: 'answer',
        },
      ],
    };
    const archive: AgentConversationArchive = {
      format: 'stitchkit.agent-conversation',
      formatVersion: 1,
      conversationId: 'source',
      events: [
        {
          schemaVersion: 1,
          eventId: 'baseline',
          conversationId: 'source',
          seq: 1,
          kind: 'runtime/baseline',
          occurredAt: branchTime,
          payload: z.json().parse(baseline),
        },
      ],
      projections: [
        {
          archiveType: 'runtime-snapshot',
          snapshot: {
            schemaVersion: 1,
            conversationId: 'source',
            version: 4,
            messages: [summary],
            runs: [],
          },
        },
      ],
      spills: [
        {
          reference: 'baseline-ref',
          runId: 'run',
          toolCallId: 'baseline-call',
          bytes: 3,
          sha256: createHash('sha256').update('abc').digest('hex'),
          base64: 'YWJj',
          mediaType: 'text/plain',
          createdAt: branchTime,
        },
      ],
    };
    for (const store of [sqlite.store, createMemoryAgentRuntimeStore()]) {
      await branch(store, {
        artifactAuthorization: { operation: 'read', path: 'destination' },
        requestKey: 'baseline',
        destinationConversationId: 'copy',
        source: { kind: 'archive', bytes: encodeAgentConversationArchive(archive) },
      });
      expect(
        (await store.loadSnapshot('copy')).messages.map((message) => message.parts),
      ).toEqual([summary.parts]);
      await branchTurn(store, 'copy', 'next');
      expect((await store.loadSnapshot('copy')).messages).toHaveLength(3);
    }
    const complete = await sqlite.conversations.messages({
      conversationId: 'copy',
      direction: 'after',
      includeCompacted: true,
      limit: 100,
    });
    expect(complete.items.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'summary',
      'user',
      'assistant',
    ]);
    expect(complete.items[0]?.parts).toEqual(input.parts);
    expect(complete.items[2]?.parts).toEqual(summary.parts);
    expect(complete.items[1]?.parts).toMatchObject([
      { type: 'tool-call', toolName: 'run_command' },
      {
        type: 'tool-result',
        toolName: 'run_command',
        output: { stdout: 'preview', artifact: { bytes: 3 } },
      },
    ]);
    expect(JSON.stringify(complete.items[1])).not.toContain('baseline-call');
    expect(JSON.stringify(complete.items[1])).not.toContain('baseline-ref');
    expect(complete.compacted).toHaveLength(2);
  } finally {
    await sqlite.close();
  }
});

test('copied state, schedules, children, pending effects and approval signatures never become destination authority', async () => {
  const sqlite = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
  const schedules = createAgentScheduleService({ sqlite, dispatch: () => undefined });
  try {
    await branchTurn(sqlite.store, 'source', 'first', [
      { type: 'tool-call', callId: 'call', toolName: 'example', input: {} },
      {
        type: 'tool-approval-request',
        approvalId: 'approval',
        callId: 'call',
        signature: 'source-signature',
        isAutomatic: true,
      },
      { type: 'tool-approval-response', approvalId: 'approval', approved: true },
      {
        type: 'tool-result',
        callId: 'call',
        toolName: 'example',
        outcome: 'success',
        output: 'historical result',
      },
    ]);
    const state = createAgentStateSlotStore({
      store: sqlite.store,
      definitions: [defineStateSlot({ name: 'permission', schema: z.boolean() })],
    });
    await state.set({
      conversationId: 'source',
      name: 'permission',
      value: true,
      actor: 'human',
    });
    await schedules.scheduleInput({
      conversationId: 'source',
      input: { action: 'future' },
      afterMs: 3_600_000,
    });
    await sqlite.store.appendEvent({
      conversationId: 'source',
      kind: 'child/spawned',
      payload: { childConversationId: 'child', seedUptoSeq: 3, budget: {} },
    });
    await sqlite.store.appendEvent({
      conversationId: 'source',
      kind: 'durability/effect',
      payload: { runId: 'first', effectName: 'pending', phase: 'intent' },
    });
    await sqlite.store.appendEvent({
      conversationId: 'source',
      kind: 'durability/step',
      payload: { runId: 'first', stepName: 'recorded', encoded: '"source result"' },
    });
    await branch(sqlite.store, {
      requestKey: 'authority',
      destinationConversationId: 'copy',
      source: { kind: 'conversation', conversationId: 'source' },
    });
    expect(await state.get('source', 'permission')).toMatchObject({ value: true });
    expect(await state.get('copy', 'permission')).toBeUndefined();
    expect(schedules.listSchedules('source')).toHaveLength(1);
    expect(schedules.listSchedules('copy')).toHaveLength(0);
    const snapshot = await sqlite.store.loadSnapshot('copy');
    const clonedRunId = snapshot.runs[0]?.id;
    if (!clonedRunId) throw new Error('Missing copied run');
    const destinationDurability = createLocalStepDurability({
      store: sqlite.store,
      conversationId: 'copy',
      runId: clonedRunId,
    });
    expect(await destinationDurability.readRecordedStep('recorded')).toBeUndefined();
    const events = await sqlite.store.readEvents({ conversationId: 'copy', limit: 100 });
    expect(
      events.items.filter((event) =>
        [
          'state/set',
          'schedule/set',
          'child/spawned',
          'durability/effect',
          'durability/step',
        ].includes(event.kind),
      ),
    ).toHaveLength(0);
    expect(
      events.items.filter((event) => event.kind === 'runtime/branch-observation'),
    ).toHaveLength(5);
    expect(JSON.stringify(events)).toContain('source result');
    expect(JSON.stringify(events)).not.toContain('source-signature');
    const approval = snapshot.messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === 'tool-approval-request');
    expect(approval).toMatchObject({ type: 'tool-approval-request' });
    expect(approval).not.toHaveProperty('signature');
    expect(approval).not.toHaveProperty('isAutomatic');
  } finally {
    schedules.close();
    await sqlite.close();
  }
});
