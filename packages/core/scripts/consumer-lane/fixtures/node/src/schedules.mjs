/** A schedule that fires after a restart is delivered late and says by how much. */
import { createAgentScheduleService } from 'stitchkit/agent-runtime';
import { packedSqlite, proof } from './packed-sqlite.mjs';

const { handle } = packedSqlite();
let current = new Date('2026-09-08T01:00:00.000Z');
const deliveries = [];
const schedules = createAgentScheduleService({
  host: handle.host,
  maxActivePerConversation: 4,
  minIntervalMs: 60_000,
  dispatch: (delivery) => {
    deliveries.push(delivery);
  },
  now: () => current,
  setTimer: () => 0,
  clearTimer: () => undefined,
});
try {
  await schedules.scheduleInput({
    conversationId: 's',
    input: { wake: true },
    afterMs: 1_000,
  });
  current = new Date('2026-09-08T01:00:03.000Z');
  await schedules.tick();
  const listedPromise = schedules.listSchedules('s');
  const listed = await listedPromise;
  const kinds = (await handle.store.readEvents({ conversationId: 's', limit: 10 })).items.map(
    (e) => e.kind,
  );
  proof(
    'schedules',
    listedPromise instanceof Promise &&
      listed.length === 1 &&
      listed[0].state === 'completed' &&
      deliveries.length === 1 &&
      deliveries[0].schedule.lateByMs === 2_000 &&
      kinds.includes('schedule/late'),
    `listed ${JSON.stringify(listed)}, deliveries ${JSON.stringify(deliveries)}, kinds ${kinds.join(',')}`,
  );
} finally {
  schedules.close();
  await handle.close();
}
