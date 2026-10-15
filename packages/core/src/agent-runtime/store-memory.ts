import { z } from 'zod';
import {
  type AgentStoreEventEnvelope,
  AgentStoreEventEnvelopeSchema,
} from '../durability/events';
import { type AgentMessage, AgentMessageSchema, AgentRecordIdSchema } from './schemas';
import {
  type AgentRecoverableDescriptor,
  type AgentRecoverablePage,
  AgentRecoverablePageSchema,
  type AgentRuntimeStore,
} from './store';
import { createAgentRuntimeStore } from './store-create';
import {
  type AgentAdmissionReceipt,
  AgentAdmissionReceiptSchema,
  AgentHistoryMutationSchema,
  type AgentRuntimeHead,
  AgentRuntimeHeadSchema,
  type AgentRuntimeStoreDriver,
  type AgentSeedReceipt,
  AgentSeedReceiptSchema,
  type AgentStoredRun,
  AgentStoredRunSchema,
  isActiveRunState,
} from './store-driver-contract';
import { memoryArchive } from './store-memory-archive';
import { memoryEvents } from './store-memory-events';
import { replaceMessage } from './store-snapshot';

const RecoverableCursorSchema = z.tuple([AgentRecordIdSchema, AgentRecordIdSchema]);

function recoverableCursor(input: AgentRecoverableDescriptor): string {
  return JSON.stringify([input.conversationId, input.run.id]);
}

function parseRecoverableCursor(cursor: string): readonly [string, string] {
  return RecoverableCursorSchema.parse(JSON.parse(cursor));
}

interface MemoryTransaction {
  purged: Set<string>;
  heads: Map<string, AgentRuntimeHead>;
  runs: Map<string, Map<string, AgentStoredRun>>;
  admissions: Map<string, Map<string, AgentAdmissionReceipt>>;
  seeds: Map<string, Map<string, AgentSeedReceipt>>;
  histories: Map<string, AgentMessage[]>;
  events: Map<string, AgentStoreEventEnvelope[]>;
  spills: Map<string, import('./archive-spill').ArchiveSpill[]>;
}

function cloneHeadMap(source: ReadonlyMap<string, AgentRuntimeHead>) {
  return new Map(
    [...source].map(([key, value]) => [
      key,
      AgentRuntimeHeadSchema.parse(structuredClone(value)),
    ]),
  );
}

function cloneNestedMap<VALUE>(
  source: ReadonlyMap<string, ReadonlyMap<string, VALUE>>,
  clone: (value: VALUE) => VALUE,
): Map<string, Map<string, VALUE>> {
  return new Map(
    [...source].map(([outerKey, values]) => [
      outerKey,
      new Map([...values].map(([innerKey, value]) => [innerKey, clone(value)])),
    ]),
  );
}

function cloneHistoryMap(source: ReadonlyMap<string, readonly AgentMessage[]>) {
  return new Map(
    [...source].map(([key, value]) => [
      key,
      value.map((message) => AgentMessageSchema.parse(structuredClone(message))),
    ]),
  );
}

type MemoryDriver = AgentRuntimeStoreDriver<MemoryTransaction>;

const memoryConversations: NonNullable<MemoryDriver['conversations']> = {
  async isEmpty(transaction, id) {
    return (
      !transaction.heads.has(id) &&
      !transaction.runs.has(id) &&
      !transaction.admissions.has(id) &&
      !transaction.seeds.has(id) &&
      !transaction.histories.has(id) &&
      !transaction.events.has(id) &&
      !transaction.spills.has(id)
    );
  },
  async isPurged(transaction, conversationId) {
    return transaction.purged.has(conversationId);
  },
  async remove(transaction, conversationId) {
    transaction.purged.add(conversationId);
    transaction.heads.delete(conversationId);
    transaction.runs.delete(conversationId);
    transaction.admissions.delete(conversationId);
    transaction.seeds.delete(conversationId);
    transaction.histories.delete(conversationId);
    transaction.events.delete(conversationId);
    transaction.spills.delete(conversationId);
  },
};

const memoryHead: MemoryDriver['head'] = {
  async load(transaction, conversationId) {
    const head = transaction.heads.get(conversationId);
    return head ? AgentRuntimeHeadSchema.parse(structuredClone(head)) : undefined;
  },
  async compareAndSwap(transaction, input) {
    const current = transaction.heads.get(input.conversationId);
    const actualVersion = current?.version ?? 0;
    if (actualVersion !== input.expectedVersion) {
      return { outcome: 'conflict', actualVersion };
    }
    transaction.heads.set(
      input.conversationId,
      AgentRuntimeHeadSchema.parse(structuredClone(input.next)),
    );
    return { outcome: 'applied' };
  },
};

const memoryRuns: MemoryDriver['runs'] = {
  async load(transaction, input) {
    const record = transaction.runs.get(input.conversationId)?.get(input.runId);
    return record ? AgentStoredRunSchema.parse(structuredClone(record)) : undefined;
  },
  async loadByAssistantMessageId(transaction, input) {
    const record = [...(transaction.runs.get(input.conversationId)?.values() ?? [])].find(
      (candidate) => candidate.run.assistantMessageId === input.assistantMessageId,
    );
    return record ? AgentStoredRunSchema.parse(structuredClone(record)) : undefined;
  },
  async loadMany(transaction, input) {
    const records = transaction.runs.get(input.conversationId);
    return input.runIds.flatMap((runId) => {
      const record = records?.get(runId);
      return record ? [AgentStoredRunSchema.parse(structuredClone(record))] : [];
    });
  },
  async listActive(transaction, conversationId) {
    return [...(transaction.runs.get(conversationId)?.values() ?? [])]
      .filter((record) => isActiveRunState(record.run.state))
      .map((record) => AgentStoredRunSchema.parse(structuredClone(record)));
  },
  async save(transaction, rawRecord) {
    const record = AgentStoredRunSchema.parse(structuredClone(rawRecord));
    const conversationRuns = transaction.runs.get(record.run.conversationId) ?? new Map();
    const collision = [...conversationRuns.values()].find(
      (candidate) =>
        candidate.run.id !== record.run.id &&
        candidate.run.assistantMessageId === record.run.assistantMessageId,
    );
    if (collision) throw new TypeError('Assistant message identity is already reserved');
    conversationRuns.set(record.run.id, record);
    transaction.runs.set(record.run.conversationId, conversationRuns);
  },
};

const memoryAdmissions: MemoryDriver['admissions'] = {
  async load(transaction, input) {
    const receipt = transaction.admissions
      .get(input.conversationId)
      ?.get(input.idempotencyKey);
    return receipt ? AgentAdmissionReceiptSchema.parse(structuredClone(receipt)) : undefined;
  },
  async loadByInputMessageId(transaction, input) {
    const receipt = [
      ...(transaction.admissions.get(input.conversationId)?.values() ?? []),
    ].find((candidate) => candidate.input.id === input.inputMessageId);
    return receipt ? AgentAdmissionReceiptSchema.parse(structuredClone(receipt)) : undefined;
  },
  async create(transaction, rawReceipt) {
    const receipt = AgentAdmissionReceiptSchema.parse(structuredClone(rawReceipt));
    const conversationAdmissions =
      transaction.admissions.get(receipt.conversationId) ?? new Map();
    if (
      conversationAdmissions.has(receipt.idempotencyKey) ||
      [...conversationAdmissions.values()].some(
        (candidate) => candidate.input.id === receipt.input.id,
      )
    ) {
      throw new TypeError('Admission identity is already reserved');
    }
    conversationAdmissions.set(receipt.idempotencyKey, receipt);
    transaction.admissions.set(receipt.conversationId, conversationAdmissions);
  },
};

const memorySeeds: MemoryDriver['seeds'] = {
  async load(transaction, input) {
    const receipt = transaction.seeds.get(input.conversationId)?.get(input.seedKey);
    return receipt ? AgentSeedReceiptSchema.parse(structuredClone(receipt)) : undefined;
  },
  async create(transaction, rawReceipt) {
    const receipt = AgentSeedReceiptSchema.parse(structuredClone(rawReceipt));
    const conversationSeeds = transaction.seeds.get(receipt.conversationId) ?? new Map();
    if (conversationSeeds.has(receipt.seedKey)) {
      throw new TypeError('Conversation seed identity is already reserved');
    }
    conversationSeeds.set(receipt.seedKey, receipt);
    transaction.seeds.set(receipt.conversationId, conversationSeeds);
  },
};

const memoryHistory: MemoryDriver['history'] = {
  async restore(transaction, input) {
    const compacted = new Set(input.compactedMessageIds);
    transaction.histories.set(
      input.conversationId,
      input.messages
        .filter((message) => !compacted.has(message.id))
        .map((message) => AgentMessageSchema.parse(structuredClone(message))),
    );
  },
  async load(transaction, conversationId) {
    return (transaction.histories.get(conversationId) ?? []).map((message) =>
      AgentMessageSchema.parse(structuredClone(message)),
    );
  },
  async hasMessage(transaction, input) {
    return (transaction.histories.get(input.conversationId) ?? []).some(
      (message) => message.id === input.messageId,
    );
  },
  async apply(transaction, rawMutation) {
    const mutation = AgentHistoryMutationSchema.parse(rawMutation);
    const conversationId =
      mutation.type === 'admit'
        ? mutation.input.conversationId
        : mutation.type === 'upsert-assistant'
          ? mutation.message.conversationId
          : mutation.type === 'seed'
            ? mutation.message.conversationId
            : mutation.summary.conversationId;
    const current = transaction.histories.get(conversationId) ?? [];
    if (mutation.type === 'admit') {
      transaction.histories.set(conversationId, [...current, mutation.input]);
      return;
    }
    if (mutation.type === 'upsert-assistant') {
      transaction.histories.set(conversationId, replaceMessage(current, mutation.message));
      return;
    }
    if (mutation.type === 'seed') {
      // A seed identity already present in history is replaced in place,
      // never prepended twice: a driver-level retry that slipped past the
      // shared check must stay idempotent instead of corrupting history.
      const existingIndex = current.findIndex((message) => message.id === mutation.message.id);
      if (existingIndex === -1) {
        transaction.histories.set(conversationId, [mutation.message, ...current]);
      } else {
        const next = [...current];
        next[existingIndex] = mutation.message;
        transaction.histories.set(conversationId, next);
      }
      return;
    }
    const replaced = new Set(mutation.replacedMessageIds);
    const positions = current
      .map((message, index) => (replaced.has(message.id) ? index : undefined))
      .filter((index) => index !== undefined);
    const first = positions[0];
    if (first === undefined) throw new Error('Compaction history range disappeared');
    transaction.histories.set(conversationId, [
      ...current.slice(0, first),
      mutation.summary,
      ...current.slice(first + positions.length),
    ]);
  },
};

/** The keyset-paginated recovery scan over the committed (not transactional) runs. */
function scanMemoryRecoverable(
  runs: ReadonlyMap<string, ReadonlyMap<string, AgentStoredRun>>,
  input: { cursor?: string; limit: number },
): AgentRecoverablePage {
  const descriptors = [...runs]
    .flatMap(([conversationId, conversationRuns]) =>
      [...conversationRuns.values()]
        .filter((record) => isActiveRunState(record.run.state))
        .map((record) => ({ conversationId, run: record.run })),
    )
    .sort(
      (left, right) =>
        left.conversationId.localeCompare(right.conversationId) ||
        left.run.id.localeCompare(right.run.id),
    );
  const cursorTuple = input.cursor ? parseRecoverableCursor(input.cursor) : undefined;
  // Keyset, not "the index after the cursor". Looking the cursor up by
  // identity returns -1 the moment that run stops being recoverable — which
  // is the *normal* outcome of a recovery pass, since recovering a run is
  // what takes it out of the set — and `-1 + 1` restarted the scan at the
  // beginning. A pass then re-visited conversations it had handled and
  // burned its budget without reaching the tail. This is the reference
  // implementation adapter authors copy.
  const start = cursorTuple
    ? descriptors.findIndex(
        (item) =>
          item.conversationId.localeCompare(cursorTuple[0]) > 0 ||
          (item.conversationId === cursorTuple[0] &&
            item.run.id.localeCompare(cursorTuple[1]) > 0),
      )
    : 0;
  if (start === -1) {
    return AgentRecoverablePageSchema.parse({ items: [] });
  }
  const items = descriptors.slice(start, start + input.limit);
  const last = items.at(-1);
  const hasMore = start + items.length < descriptors.length;
  return AgentRecoverablePageSchema.parse({
    items,
    ...(hasMore && last && { nextCursor: recoverableCursor(last) }),
  });
}

/** In-memory reference adapter backed by the same reducer and driver contract as durable stores. */
export function createMemoryAgentRuntimeStore(): AgentRuntimeStore &
  Required<Pick<AgentRuntimeStore, 'branchConversation'>> {
  let purged = new Set<string>();
  let heads = new Map<string, AgentRuntimeHead>();
  let runs = new Map<string, Map<string, AgentStoredRun>>();
  let admissions = new Map<string, Map<string, AgentAdmissionReceipt>>();
  let seeds = new Map<string, Map<string, AgentSeedReceipt>>();
  let histories = new Map<string, AgentMessage[]>();
  let events = new Map<string, AgentStoreEventEnvelope[]>();
  let spills = new Map<string, import('./archive-spill').ArchiveSpill[]>();
  let transactionTail = Promise.resolve();

  const driver: AgentRuntimeStoreDriver<MemoryTransaction> = {
    async transaction(work) {
      const previous = transactionTail;
      const release = Promise.withResolvers<void>();
      transactionTail = previous.catch(() => undefined).then(() => release.promise);
      await previous.catch(() => undefined);
      const transaction = {
        purged: new Set(purged),
        spills: structuredClone(spills),
        heads: cloneHeadMap(heads),
        runs: cloneNestedMap(runs, (record) =>
          AgentStoredRunSchema.parse(structuredClone(record)),
        ),
        admissions: cloneNestedMap(admissions, (receipt) =>
          AgentAdmissionReceiptSchema.parse(structuredClone(receipt)),
        ),
        seeds: cloneNestedMap(seeds, (receipt) =>
          AgentSeedReceiptSchema.parse(structuredClone(receipt)),
        ),
        histories: cloneHistoryMap(histories),
        events: new Map(
          [...events].map(([conversationId, stored]) => [
            conversationId,
            stored.map((event) => AgentStoreEventEnvelopeSchema.parse(structuredClone(event))),
          ]),
        ),
      };
      try {
        const result = await work(transaction);
        purged = transaction.purged;
        spills = transaction.spills;
        heads = transaction.heads;
        runs = transaction.runs;
        admissions = transaction.admissions;
        seeds = transaction.seeds;
        histories = transaction.histories;
        events = transaction.events;
        return result;
      } finally {
        release.resolve();
      }
    },
    conversations: memoryConversations,
    head: memoryHead,
    runs: memoryRuns,
    admissions: memoryAdmissions,
    seeds: memorySeeds,
    history: memoryHistory,
    events: memoryEvents,
    archive: memoryArchive,
    async scanRecoverable(input) {
      return scanMemoryRecoverable(runs, input);
    },
  };
  return createAgentRuntimeStore(driver);
}
