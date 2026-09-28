import { createHash } from 'node:crypto';
import { type AppendAgentStoreEvent, AppendAgentStoreEventSchema } from '../durability/events';
import { AgentConversationPurgedError } from './purge';
import type { AgentRuntimeStoreDriver } from './store-driver-contract';
import { agentStoreEventDraft } from './store-events';

/** A durable admission fence in the same transaction and log as ordinary events. */
export function appendEventOnce<TRANSACTION>(
  driver: AgentRuntimeStoreDriver<TRANSACTION>,
  input: AppendAgentStoreEvent,
  key: string,
) {
  const parsed = AppendAgentStoreEventSchema.parse(input);
  if (!key) throw new TypeError('Event admission key must not be empty');
  const eventId = createHash('sha256')
    .update(JSON.stringify([parsed.conversationId, parsed.kind, key]))
    .digest('hex');
  return driver.transaction(async (transaction) => {
    if (await driver.conversations?.isPurged(transaction, parsed.conversationId)) {
      throw new AgentConversationPurgedError();
    }
    let fromSeq: number | undefined;
    do {
      const page = await driver.events.list(transaction, {
        conversationId: parsed.conversationId,
        fromSeq,
        limit: 10_000,
      });
      const previous = page.items.find((event) => event.eventId === eventId);
      if (previous)
        return { outcome: 'duplicate', event: previous } satisfies {
          outcome: 'duplicate';
          event: typeof previous;
        };
      fromSeq = page.nextSeq;
    } while (fromSeq !== undefined);
    const event = await driver.events.append(transaction, {
      ...agentStoreEventDraft(parsed),
      eventId,
    });
    return { outcome: 'applied', event } satisfies { outcome: 'applied'; event: typeof event };
  });
}
