import { z } from 'zod';
import {
  type AgentStoreEventEnvelope,
  AgentStoreEventPageSchema,
  ReadAgentStoreEventsSchema,
} from '../durability/events';
import { AgentSnapshotSchema } from './schemas';
import {
  AgentAdmissionReceiptSchema,
  AgentRuntimeHeadSchema,
  type AgentRuntimeStoreDriver,
  AgentStoredRunSchema,
} from './store-driver-contract';
import {
  AgentStoreTransitionSchema,
  decodeAgentConversationArchive,
  encodeAgentConversationArchive,
} from './store-events';
import { snapshotIn } from './store-reads';

/**
 * One read transaction for the whole archive.
 *
 * Events, the durable companions and the snapshot used to be three separate
 * reads; a spill cleanup or a run transition landing between them produced
 * an archive whose parts disagreed — a `spill/created` without its payload,
 * a snapshot newer than its last transition — and an import of it restored a
 * state no event had produced.
 */
export function exportConversation<TRANSACTION>(
  driver: AgentRuntimeStoreDriver<TRANSACTION>,
  conversationId: string,
): Promise<Uint8Array> {
  return driver.transaction(
    async (transaction) => {
      const events: AgentStoreEventEnvelope[] = [];
      let fromSeq: number | undefined;
      do {
        const page = AgentStoreEventPageSchema.parse(
          await driver.events.list(
            transaction,
            ReadAgentStoreEventsSchema.parse({
              conversationId,
              ...(fromSeq && { fromSeq }),
              limit: 10_000,
            }),
          ),
        );
        events.push(...page.items);
        fromSeq = page.nextSeq;
      } while (fromSeq !== undefined);
      const durable = (await driver.archive?.export(transaction, conversationId)) ?? {
        projections: [],
        spills: [],
      };
      const snapshot = await snapshotIn(driver, transaction, conversationId);
      return encodeAgentConversationArchive({
        format: 'stitchkit.agent-conversation',
        formatVersion: 1,
        conversationId,
        events,
        projections: [
          { archiveType: 'runtime-snapshot', snapshot: z.json().parse(snapshot) },
          ...durable.projections,
        ],
        spills: durable.spills,
      });
    },
    { access: 'read' },
  );
}

export async function importConversation<TRANSACTION>(
  driver: AgentRuntimeStoreDriver<TRANSACTION>,
  bytes: Uint8Array,
): Promise<{ conversationId: string; events: number }> {
  const archive = decodeAgentConversationArchive(bytes);
  return driver.transaction(async (transaction) => {
    const existing = await driver.events.list(transaction, {
      conversationId: archive.conversationId,
      limit: 1,
    });
    if (existing.items.length > 0) {
      throw new TypeError('Conversation event log must be empty before import');
    }
    for (const event of archive.events) {
      const appended = await driver.events.append(transaction, {
        schemaVersion: event.schemaVersion,
        eventId: event.eventId,
        conversationId: event.conversationId,
        kind: event.kind,
        occurredAt: event.occurredAt,
        payload: event.payload,
        ...(event.ignorable && { ignorable: true }),
      });
      if (appended.seq !== event.seq) {
        throw new TypeError('Conversation archive event sequence is not contiguous');
      }
    }
    const snapshotEntry = archive.projections.find(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        !Array.isArray(entry) &&
        entry.archiveType === 'runtime-snapshot',
    );
    if (snapshotEntry && typeof snapshotEntry === 'object' && !Array.isArray(snapshotEntry)) {
      const snapshot = AgentSnapshotSchema.parse(snapshotEntry.snapshot);
      if (snapshot.conversationId !== archive.conversationId) {
        throw new TypeError('Conversation archive snapshot belongs to another conversation');
      }
      if (snapshot.version > 0 || snapshot.messages.length > 0 || snapshot.runs.length > 0) {
        const outcome = await driver.head.compareAndSwap(transaction, {
          conversationId: snapshot.conversationId,
          expectedVersion: 0,
          next: AgentRuntimeHeadSchema.parse({
            schemaVersion: 1,
            conversationId: snapshot.conversationId,
            version: snapshot.version,
          }),
        });
        if (outcome.outcome !== 'applied') {
          throw new TypeError('Conversation archive snapshot target is not empty');
        }
      }
      for (const run of snapshot.runs) {
        const terminalAssistant = snapshot.messages.find(
          (message) => message.id === run.assistantMessageId,
        );
        await driver.runs.save(
          transaction,
          AgentStoredRunSchema.parse({
            schemaVersion: 1,
            run,
            ...(terminalAssistant && { terminalAssistant }),
          }),
        );
      }
      for (const message of snapshot.messages) {
        await driver.history.apply(transaction, { type: 'admit', input: message });
      }
      for (const event of archive.events) {
        if (event.kind !== 'runtime/transition') continue;
        const transition = AgentStoreTransitionSchema.parse(event.payload);
        if (transition.type !== 'accept') continue;
        const assigned = snapshot.runs.find((run) =>
          run.inputMessageIds.includes(transition.input.input.id),
        );
        if (!assigned) {
          throw new TypeError('Conversation archive admission has no assigned run');
        }
        await driver.admissions.create(
          transaction,
          AgentAdmissionReceiptSchema.parse({
            schemaVersion: 1,
            conversationId: archive.conversationId,
            idempotencyKey: transition.input.idempotencyKey,
            input: transition.input.input,
            runId: assigned.id,
            assistantMessageId: assigned.assistantMessageId,
          }),
        );
      }
    }
    await driver.archive?.import(transaction, archive);
    return { conversationId: archive.conversationId, events: archive.events.length };
  });
}
