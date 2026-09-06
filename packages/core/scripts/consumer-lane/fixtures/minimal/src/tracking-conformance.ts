/**
 * `stitchkit/tracking` and `stitchkit/tracking/server`, executed from the
 * packed package by a consumer with no optional peer installed. The outbox
 * runs over the memory adapter (there is no IndexedDB here); the server half
 * decides a batch. Both entries are peer-free by design and this is the proof.
 */
import {
  createTrackingOutbox,
  createTrackingSchemas,
  memoryOutboxStorage,
} from 'stitchkit/tracking';
import { dispositionTrackingBatch, hashTrackingEvent } from 'stitchkit/tracking/server';

const outbox = createTrackingOutbox(
  memoryOutboxStorage<{ eventId: string; browserSequence: number }>(),
);
const [first, second] = await outbox.reserveSequences(2);
if (first !== 1 || second !== 2) throw new Error(`reserved ${first},${second}`);
await outbox.enqueue({ eventId: 'a', browserSequence: 1 });
if ((await outbox.readBatch()).length !== 1) throw new Error('enqueue did not persist');
if (!(await outbox.acquireLease('tab'))) throw new Error('lease refused');
await outbox.releaseLease('tab');

const schemas = createTrackingSchemas({ eventTypes: ['PAGE_VIEW'] });
const event = schemas.event.parse({
  eventId: '00000000-0000-4000-8000-000000000001',
  visitId: '00000000-0000-4000-8000-000000000002',
  browserStreamId: '00000000-0000-4000-8000-000000000003',
  browserSequence: 1,
  type: 'PAGE_VIEW',
  page: '/',
  clientTimestamp: 1,
});
const decided = dispositionTrackingBatch({
  events: [event, event],
  visits: [{ id: event.visitId, browserStreamId: event.browserStreamId, ownerId: null }],
  existing: new Map([[event.eventId, hashTrackingEvent(event)]]),
  actorOwnerId: null,
});
if (decided.dispositions.map((d) => d.status).join(',') !== 'duplicate,duplicate') {
  throw new Error(`unexpected dispositions ${JSON.stringify(decided.dispositions)}`);
}
console.log('tracking conformance: ok');
