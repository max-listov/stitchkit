import { createHash } from 'node:crypto';
import {
  type AgentStoreEventEnvelope,
  type AppendAgentStoreEvent,
  AppendAgentStoreEventSchema,
} from '../durability/events';
import { AgentConversationPurgedError } from './purge';
import type { AgentRuntimeStoreDriver } from './store-driver-contract';
import { agentStoreEventDraft } from './store-events';

/** The identity a once-only event carries: the same key always names the same event. */
export function eventOnceId(conversationId: string, kind: string, key: string): string {
  if (!key) throw new TypeError('Event admission key must not be empty');
  return createHash('sha256')
    .update(JSON.stringify([conversationId, kind, key]))
    .digest('hex');
}

async function findEvent<TRANSACTION>(
  driver: AgentRuntimeStoreDriver<TRANSACTION>,
  transaction: TRANSACTION,
  conversationId: string,
  eventId: string,
): Promise<AgentStoreEventEnvelope | undefined> {
  if (driver.events.find) return driver.events.find(transaction, { conversationId, eventId });
  // A driver without `find` is paged through; linear in the log, kept for
  // drivers written against the contract before `find` existed.
  let fromSeq: number | undefined;
  do {
    const page = await driver.events.list(transaction, {
      conversationId,
      fromSeq,
      limit: 10_000,
    });
    const found = page.items.find((event) => event.eventId === eventId);
    if (found) return found;
    fromSeq = page.nextSeq;
  } while (fromSeq !== undefined);
  return undefined;
}

/** A durable admission fence in the same transaction and log as ordinary events. */
export function appendEventOnce<TRANSACTION>(
  driver: AgentRuntimeStoreDriver<TRANSACTION>,
  input: AppendAgentStoreEvent,
  key: string,
) {
  const parsed = AppendAgentStoreEventSchema.parse(input);
  const eventId = eventOnceId(parsed.conversationId, parsed.kind, key);
  return driver.transaction(async (transaction) => {
    if (await driver.conversations?.isPurged(transaction, parsed.conversationId)) {
      throw new AgentConversationPurgedError();
    }
    const previous = await findEvent(driver, transaction, parsed.conversationId, eventId);
    if (previous)
      return { outcome: 'duplicate', event: previous } satisfies {
        outcome: 'duplicate';
        event: typeof previous;
      };
    const event = await driver.events.append(transaction, {
      ...agentStoreEventDraft(parsed),
      eventId,
    });
    return { outcome: 'applied', event } satisfies { outcome: 'applied'; event: typeof event };
  });
}

/** The event `appendEventOnce` wrote for this kind and key, if any. */
export function findEventOnce<TRANSACTION>(
  driver: AgentRuntimeStoreDriver<TRANSACTION>,
  input: { conversationId: string; kind: string; key: string },
): Promise<AgentStoreEventEnvelope | undefined> {
  const eventId = eventOnceId(input.conversationId, input.kind, input.key);
  return driver.transaction(
    (transaction) => findEvent(driver, transaction, input.conversationId, eventId),
    { access: 'read' },
  );
}
