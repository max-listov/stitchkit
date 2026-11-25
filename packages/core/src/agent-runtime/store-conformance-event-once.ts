import type { AgentRuntimeStore } from './store';

/**
 * Once-only event admission: hit (duplicate), miss (new key), and cross-conversation miss.
 *
 * Exercises `driver.events.find` through the public store boundary so an adapter
 * whose `find` misses or allows duplicate writes fails conformance immediately. A
 * `find` that ignores `conversationId` is not caught here and does not need to be:
 * the once-only identity hashes the conversation, so the same kind and key in two
 * conversations are two event ids.
 */
export async function eventOnceScenario(
  store: AgentRuntimeStore,
  conversationId: string,
  otherConversationId: string,
): Promise<void> {
  if (!store.appendEventOnce || !store.findEventOnce) {
    throw new Error(
      'Event-once conformance: store must implement appendEventOnce and findEventOnce',
    );
  }
  const missing = await store.findEventOnce({
    conversationId,
    kind: 'state/set',
    key: 'once-a',
  });
  if (missing !== undefined) {
    throw new Error('Event-once conformance: empty conversation matched an unwritten key');
  }

  const first = await store.appendEventOnce(
    { conversationId, kind: 'state/set', payload: { n: 1 } },
    'once-a',
  );
  if (
    first.outcome !== 'applied' ||
    first.event.conversationId !== conversationId ||
    first.event.seq !== 1
  ) {
    throw new Error(
      `Event-once conformance: expected first admission to apply at seq 1, received ${first.outcome} at seq ${first.event.seq}`,
    );
  }

  const found = await store.findEventOnce({
    conversationId,
    kind: 'state/set',
    key: 'once-a',
  });
  if (found?.seq !== first.event.seq || found.eventId !== first.event.eventId) {
    throw new Error('Event-once conformance: findEventOnce did not return the admitted event');
  }

  // Hit: repeating the same key must return the original envelope without appending a second row.
  const duplicate = await store.appendEventOnce(
    { conversationId, kind: 'state/set', payload: { n: 999 } },
    'once-a',
  );
  if (
    duplicate.outcome !== 'duplicate' ||
    duplicate.event.seq !== first.event.seq ||
    duplicate.event.eventId !== first.event.eventId
  ) {
    throw new Error(
      `Event-once conformance: duplicate key must return the original event at seq ${first.event.seq}, received ${duplicate.outcome} at seq ${duplicate.event.seq}`,
    );
  }
  const afterDuplicate = await store.readEvents({ conversationId, limit: 10 });
  if (afterDuplicate.items.length !== 1) {
    throw new Error(
      `Event-once conformance: duplicate admission appended an extra row (${afterDuplicate.items.length} events stored)`,
    );
  }

  // Miss: a distinct key in the same conversation inserts a new event.
  const second = await store.appendEventOnce(
    { conversationId, kind: 'state/set', payload: { n: 2 } },
    'once-b',
  );
  if (
    second.outcome !== 'applied' ||
    second.event.seq !== 2 ||
    second.event.eventId === first.event.eventId
  ) {
    throw new Error(
      `Event-once conformance: distinct key must apply at seq 2, received ${second.outcome} at seq ${second.event.seq}`,
    );
  }
  const stillMissing = await store.findEventOnce({
    conversationId,
    kind: 'state/set',
    key: 'once-missing',
  });
  if (stillMissing !== undefined) {
    throw new Error('Event-once conformance: findEventOnce matched an unknown key');
  }

  // Cross-conversation miss: the same kind and key in another conversation is not a duplicate.
  const foreignLookup = await store.findEventOnce({
    conversationId: otherConversationId,
    kind: 'state/set',
    key: 'once-a',
  });
  if (foreignLookup !== undefined) {
    throw new Error(
      'Event-once conformance: findEventOnce leaked an admission from another conversation',
    );
  }
  const other = await store.appendEventOnce(
    { conversationId: otherConversationId, kind: 'state/set', payload: { n: 1 } },
    'once-a',
  );
  if (
    other.outcome !== 'applied' ||
    other.event.conversationId !== otherConversationId ||
    other.event.seq !== 1
  ) {
    throw new Error(
      `Event-once conformance: same key in another conversation must apply at seq 1, received ${other.outcome} at seq ${other.event.seq}`,
    );
  }
  const otherDuplicate = await store.appendEventOnce(
    { conversationId: otherConversationId, kind: 'state/set', payload: { n: 2 } },
    'once-a',
  );
  if (
    otherDuplicate.outcome !== 'duplicate' ||
    otherDuplicate.event.seq !== other.event.seq ||
    otherDuplicate.event.eventId !== other.event.eventId
  ) {
    throw new Error(
      'Event-once conformance: duplicate admission in peer conversation did not return its original event',
    );
  }
  const peerEvents = await store.readEvents({
    conversationId: otherConversationId,
    limit: 10,
  });
  if (peerEvents.items.length !== 1) {
    throw new Error(
      `Event-once conformance: peer conversation expected 1 event, received ${peerEvents.items.length}`,
    );
  }
}
