import {
  type AgentStoreEventEnvelope,
  AgentStoreEventEnvelopeSchema,
  AgentStoreEventPageSchema,
} from '../durability/events';
import type { AgentRuntimeStoreDriver } from './store-driver-contract';

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
};
