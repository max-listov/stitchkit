/** A schedule that fires after a restart is delivered late and says by how much. */
import { createAgentScheduleService } from 'stitchkit/agent-runtime';
import { packedSqlite, proof } from './packed-sqlite.mjs';

const { handle } = packedSqlite();
let current = new Date('2026-09-08T01:00:00.000Z');
const deliveries = [];
const schedules = createAgentScheduleService({
  sqlite: handle,
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
  const kinds = (await handle.store.readEvents({ conversationId: 's', limit: 10 })).items.map(
    (e) => e.kind,
  );
  proof(
    'schedules',
    deliveries.length === 1 &&
      deliveries[0].schedule.lateByMs === 2_000 &&
      kinds.includes('schedule/late'),
    `deliveries ${JSON.stringify(deliveries)}, kinds ${kinds.join(',')}`,
  );
} finally {
  schedules.close();
  await handle.close();
}
