import { z } from 'zod';
import {
  type AgentStoreEventEnvelope,
  AgentStoreEventPageSchema,
  ReadAgentStoreEventsSchema,
} from '../durability/events';
import { isRuntimeSnapshotEntry } from './archive-projection';
import { replayBranchEvents } from './branch-replay';
import { AgentSnapshotSchema } from './schemas';
import { assertSourceCapabilities } from './store-capabilities';
import {
  AgentRuntimeHeadSchema,
  type AgentRuntimeStoreDriver,
  AgentStoredRunSchema,
} from './store-driver-contract';
import {
  decodeAgentConversationArchive,
  encodeAgentConversationArchive,
} from './store-events';
import { snapshotIn } from './store-reads';
import { persistRuntimeReplay } from './store-replay';

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
      return exportConversationIn(driver, transaction, conversationId);
    },
    { access: 'read' },
  );
}

export async function importConversation<TRANSACTION>(
  driver: AgentRuntimeStoreDriver<TRANSACTION>,
  bytes: Uint8Array,
): Promise<{ conversationId: string; events: number }> {
  const archive = decodeAgentConversationArchive(bytes);
  const snapshotEntry = archive.projections.find(isRuntimeSnapshotEntry);
  const snapshot =
    snapshotEntry === undefined
      ? undefined
      : AgentSnapshotSchema.parse(snapshotEntry.snapshot);
  if (snapshot && snapshot.conversationId !== archive.conversationId) {
    throw new TypeError('Conversation archive snapshot belongs to another conversation');
  }
  // Replayed before the transaction: what the archive needs of the driver is
  // known, and refused, before a single row is written.
  const replay =
    snapshot && replayBranchEvents(archive.conversationId, archive.events, snapshot);
  assertSourceCapabilities(driver, {
    spills: archive.spills.length,
    projections: archive.projections.filter((entry) => !isRuntimeSnapshotEntry(entry)).length,
    compacted: replay?.baseline?.compacted?.length ?? 0,
  });
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
    if (snapshot && replay) {
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
      await persistRuntimeReplay(driver, transaction, replay);
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
      const restoredIds = new Set(
        (await driver.history.load(transaction, archive.conversationId)).map(
          (message) => message.id,
        ),
      );
      for (const message of snapshot.messages) {
        // Hash-only checkpoints keep their exact live draft in the snapshot.
        if (message.role === 'assistant')
          await driver.history.apply(transaction, { type: 'upsert-assistant', message });
        else if (!restoredIds.has(message.id))
          await driver.history.apply(transaction, { type: 'admit', input: message });
      }
    }
    await driver.archive?.import(transaction, archive);
    return { conversationId: archive.conversationId, events: archive.events.length };
  });
}

export async function exportConversationIn<TRANSACTION>(
  driver: AgentRuntimeStoreDriver<TRANSACTION>,
  transaction: TRANSACTION,
  conversationId: string,
): Promise<Uint8Array> {
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
}
