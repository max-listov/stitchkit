import { expect, test } from 'bun:test';
import { z } from 'zod';
import { createBunSqliteAgentRuntimeStore } from '../src/agent-runtime/sqlite-bun';
import {
  AgentMessageSchema,
  AgentRunSchema,
  AgentStoreTransitionSchema,
  createMemoryAgentRuntimeStore,
  decodeAgentConversationArchive,
  encodeAgentConversationArchive,
} from '../src/entrypoints/agent-runtime';
import { branch, branchInput, branchTime, branchTurn } from './support/agent-branch-fixture';

for (const adapter of ['memory', 'sqlite']) {
  test(`${adapter}: abandoned terminal content and clocks survive delayed branch; incomplete legacy archive refuses`, async () => {
    const sqlite =
      adapter === 'sqlite'
        ? createBunSqliteAgentRuntimeStore({ filename: ':memory:' })
        : undefined;
    const store = sqlite?.store ?? createMemoryAgentRuntimeStore();
    try {
      const run = AgentRunSchema.parse({
        schemaVersion: 1,
        id: 'abandoned',
        conversationId: 'source',
        inputMessageIds: ['input'],
        assistantMessageId: 'answer',
        state: 'queued',
        revision: 0,
        createdAt: branchTime,
        updatedAt: branchTime,
      });
      await store.acceptInputAndAssignRun({
        idempotencyKey: 'input',
        input: branchInput('source', 'input'),
        run,
      });
      await store.recoverRun({
        conversationId: 'source',
        runId: run.id,
        expectedRevision: 0,
        action: 'abandon',
      });
      const source = await store.loadRun({ conversationId: 'source', runId: run.id });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await branch(store, {
        requestKey: 'abandon',
        destinationConversationId: 'copy',
        source: { kind: 'conversation', conversationId: 'source', throughRunId: run.id },
      });
      const copied = (await store.loadSnapshot('copy')).runs[0];
      if (!copied) throw new Error('Missing abandoned run');
      const copiedView = await store.loadRun({ conversationId: 'copy', runId: copied.id });
      expect(copiedView?.assistant?.updatedAt).toBe(source?.assistant?.updatedAt);
      expect(copiedView?.assistant?.parts).toEqual(source?.assistant?.parts);
      const legacy = decodeAgentConversationArchive(await store.exportConversation('source'));
      legacy.events = legacy.events.map((event) => {
        if (event.kind !== 'runtime/transition') return event;
        const parsed = AgentStoreTransitionSchema.parse(event.payload);
        return parsed.type === 'recover'
          ? { ...event, payload: z.json().parse({ type: parsed.type, input: parsed.input }) }
          : event;
      });
      await branch(store, {
        requestKey: 'legacy',
        destinationConversationId: 'legacy',
        source: { kind: 'archive', bytes: encodeAgentConversationArchive(legacy) },
      });
      expect((await store.loadSnapshot('legacy')).messages[1]?.updatedAt).toBe(
        source?.assistant?.updatedAt,
      );
      const snapshot = await store.loadSnapshot('source');
      await store.replaceCompactedRange({
        conversationId: 'source',
        expectedVersion: snapshot.version,
        replacedMessageIds: snapshot.messages.map((message) => message.id),
        summary: AgentMessageSchema.parse({
          ...branchInput('source', 'summary'),
          role: 'summary',
        }),
      });
      const compacted = decodeAgentConversationArchive(
        await store.exportConversation('source'),
      );
      compacted.events = compacted.events.map(
        (event) =>
          legacy.events.find((original) => original.eventId === event.eventId) ?? event,
      );
      await expect(
        branch(store, {
          requestKey: 'missing',
          destinationConversationId: 'negative',
          source: { kind: 'archive', bytes: encodeAgentConversationArchive(compacted) },
        }),
      ).rejects.toThrow('no exact retained abandoned assistant');
      expect((await store.loadSnapshot('negative')).version).toBe(0);
    } finally {
      await sqlite?.close();
    }
  });

  test(`${adapter}: compacted runs keep terminalAssistant and duplicate admission evidence after lease removal`, async () => {
    const sqlite =
      adapter === 'sqlite'
        ? createBunSqliteAgentRuntimeStore({ filename: ':memory:' })
        : undefined;
    const store = sqlite?.store ?? createMemoryAgentRuntimeStore();
    try {
      const snapshot = await branchTurn(store, 'source', 'first');
      await store.replaceCompactedRange({
        conversationId: 'source',
        expectedVersion: snapshot.version,
        replacedMessageIds: snapshot.messages.map((message) => message.id),
        summary: AgentMessageSchema.parse({
          ...branchInput('source', 'summary'),
          role: 'summary',
        }),
      });
      await branch(store, {
        requestKey: 'compact',
        destinationConversationId: 'copy',
        source: { kind: 'conversation', conversationId: 'source' },
      });
      const events = await store.readEvents({ conversationId: 'copy', limit: 100 });
      const admission = events.items
        .filter((event) => event.kind === 'runtime/transition')
        .map((event) => AgentStoreTransitionSchema.parse(event.payload))
        .find((operation) => operation.type === 'accept');
      if (admission?.type !== 'accept') throw new Error('Missing copied admission');
      const retained = await store.loadRun({
        conversationId: 'copy',
        runId: admission.input.run.id,
      });
      expect(retained?.assistant?.parts).toEqual([{ type: 'text', text: 'answer first' }]);
      expect(retained?.run.ownerId).toBeUndefined();
      expect(retained?.run.fencingToken).toBeUndefined();
      const duplicate = await store.acceptInputAndAssignRun(admission.input);
      expect(duplicate.outcome).toBe('duplicate');
      if (duplicate.outcome !== 'duplicate') throw new Error('Missing duplicate result');
      expect(duplicate.assistant?.parts).toEqual(retained?.assistant?.parts);
    } finally {
      await sqlite?.close();
    }
  });
}
