import {
  type AgentStoreEventEnvelope,
  AgentStoreEventEnvelopeSchema,
  AgentStoreEventPageSchema,
} from '../durability/events';
import {
  InvocationExpiredPayloadSchema,
  parsePayloadPurgeCutoff,
  redactLiveInvocationPayload,
} from './schemas-invocation-payload';
import type { AgentRuntimeStoreDriver } from './store-driver-contract';
import { canonicalAgentJson } from './store-events';

export interface MemoryEventTransaction {
  events: Map<string, AgentStoreEventEnvelope[]>;
}

export const memoryEvents: AgentRuntimeStoreDriver<MemoryEventTransaction>['events'] = {
  async append(transaction, draft) {
    const current = transaction.events.get(draft.conversationId) ?? [];
    const event = AgentStoreEventEnvelopeSchema.parse({
      ...draft,
      seq: (current.at(-1)?.seq ?? 0) + 1,
    });
    if (current.some((candidate) => candidate.eventId === event.eventId)) {
      throw new TypeError('Agent store event identity is already present');
    }
    transaction.events.set(draft.conversationId, [...current, event]);
    return event;
  },
  async list(transaction, input) {
    const selected = (transaction.events.get(input.conversationId) ?? []).filter(
      (event) =>
        (input.fromSeq === undefined || event.seq >= input.fromSeq) &&
        (input.toSeq === undefined || event.seq <= input.toSeq),
    );
    const items = selected.slice(0, input.limit);
    const last = items.at(-1);
    return AgentStoreEventPageSchema.parse({
      items,
      ...(selected.length > items.length && last ? { nextSeq: last.seq + 1 } : {}),
    });
  },
  async find(transaction, input) {
    return (transaction.events.get(input.conversationId) ?? []).find(
      (event) => event.eventId === input.eventId,
    );
  },
  async redactExpiredPayloads(transaction, input) {
    const cutoffEpoch = parsePayloadPurgeCutoff(input.before);
    const conversationIds =
      input.conversationId !== undefined
        ? [input.conversationId]
        : [...transaction.events.keys()].sort();
    const eligible: Array<{
      conversationId: string;
      index: number;
      event: AgentStoreEventEnvelope;
    }> = [];
    for (const conversationId of conversationIds) {
      const list = transaction.events.get(conversationId);
      if (!list) continue;
      for (const [index, event] of list.entries()) {
        if (event.kind !== 'provider/payload') continue;
        if (InvocationExpiredPayloadSchema.safeParse(event.payload).success) continue;
        if (Date.parse(event.occurredAt) < cutoffEpoch) {
          eligible.push({ conversationId, index, event });
        }
      }
    }
    eligible.sort(
      (a, b) =>
        a.event.occurredAt.localeCompare(b.event.occurredAt) ||
        a.conversationId.localeCompare(b.conversationId) ||
        a.event.seq - b.event.seq,
    );
    const hasMore = eligible.length > input.limit;
    const toPurge = eligible.slice(0, input.limit);
    let freedBytes = 0;
    const updatedLists = new Map<string, AgentStoreEventEnvelope[]>();
    for (const entry of toPurge) {
      const expired = redactLiveInvocationPayload(entry.event.payload, input.expiredAt);
      if (expired === undefined) continue;
      const beforeBytes = Buffer.byteLength(canonicalAgentJson(entry.event.payload));
      const afterBytes = Buffer.byteLength(canonicalAgentJson(expired));
      freedBytes += Math.max(0, beforeBytes - afterBytes);
      const list = updatedLists.get(entry.conversationId) ?? [
        ...(transaction.events.get(entry.conversationId) ?? []),
      ];
      list[entry.index] = { ...entry.event, payload: expired };
      updatedLists.set(entry.conversationId, list);
    }
    for (const [conversationId, list] of updatedLists) {
      transaction.events.set(conversationId, list);
    }
    return { purged: toPurge.length, freedBytes, hasMore };
  },
};
