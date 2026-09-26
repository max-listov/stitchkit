import { expect, test } from 'bun:test';
import { claimSchedule } from '../src/agent-runtime/schedule-records';
import {
  createBunSqliteAgentRuntimeStore,
  createSqliteAgentRuntimeStore,
} from '../src/agent-runtime/sqlite-bun';
import { initializeAgentRuntimeSqlite } from '../src/agent-runtime/sqlite-schema';
import { createAgentScheduleService } from '../src/entrypoints/agent-runtime';
import { scheduleClock } from './fixtures/schedule-clock';

test('v3 migration retains due times, claims, cancellations and application tables', async () => {
  const sqlite = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
  const clock = scheduleClock();
  let calls = 0;
  const service = createAgentScheduleService({
    sqlite,
    ...clock,
    dispatch: () => {
      calls++;
    },
  });
  try {
    const pending = await service.scheduleInput({
      conversationId: 'migration',
      input: {},
      afterMs: 1,
    });
    const cancelled = await service.scheduleInput({
      conversationId: 'migration',
      input: {},
      afterMs: 1,
    });
    await service.cancelSchedule('migration', cancelled.id);
    clock.advance(1);
    await claimSchedule(sqlite, 'other-process', pending, clock.now);
    sqlite.database.exec(`
      CREATE TABLE application_data (value TEXT);
      INSERT INTO application_data VALUES ('untouched');
      DROP INDEX stitchkit_agent_runtime_schedules_due;
      ALTER TABLE stitchkit_agent_runtime_schedules DROP COLUMN eligible_at;
      ALTER TABLE stitchkit_agent_runtime_schedules DROP COLUMN retry_at;
      ALTER TABLE stitchkit_agent_runtime_schedules DROP COLUMN attempts;
      ALTER TABLE stitchkit_agent_runtime_schedules DROP COLUMN last_error;
      CREATE INDEX stitchkit_agent_runtime_schedules_due ON stitchkit_agent_runtime_schedules(state, next_at);
      UPDATE stitchkit_agent_runtime_meta SET value = '3' WHERE key = 'schema_version';
    `);
    initializeAgentRuntimeSqlite(sqlite.database);
    initializeAgentRuntimeSqlite(sqlite.database);
    expect(sqlite.database.prepare('SELECT * FROM application_data').get()).toEqual({
      value: 'untouched',
    });
    expect(service.listSchedules('migration').find((s) => s.id === pending.id)).toMatchObject({
      nextAt: pending.nextAt,
      attempts: 0,
    });
    await service.tick();
    expect(calls).toBe(0);
    expect(clock.delays.at(-1)).toBe(60_000);
    clock.advance(60_000);
    await service.tick();
    expect(calls).toBe(1);
    expect(service.listSchedules('migration').find((s) => s.id === cancelled.id)?.state).toBe(
      'cancelled',
    );
  } finally {
    service.close();
    await sqlite.close();
  }
});

test('stale due selection cannot claim an advanced or deferred occurrence', async () => {
  const sqlite = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
  const clock = scheduleClock();
  const service = createAgentScheduleService({ sqlite, ...clock, dispatch: () => undefined });
  try {
    const stale = await service.scheduleInput({
      conversationId: 'stale',
      input: {},
      everyMs: 1,
      timeZone: 'UTC',
    });
    clock.advance(1);
    await service.tick();
    clock.advance(1);
    expect(await claimSchedule(sqlite, 'stale', stale, clock.now)).toBeFalse();
  } finally {
    service.close();
    await sqlite.close();
  }
});

test('read failures back off with one recovery timer and recover without writes', async () => {
  const owner = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
  let failures = true;
  let reads = 0;
  let writes = 0;
  const database = {
    ...owner.database,
    close: () => undefined,
    exec(sql: string) {
      if (sql.includes('BEGIN IMMEDIATE')) writes++;
      owner.database.exec(sql);
    },
    prepare(sql: string) {
      if (sql.includes('eligible_at')) {
        reads++;
        if (failures) throw new Error('storage unavailable');
      }
      return owner.database.prepare(sql);
    },
  };
  const sqlite = createSqliteAgentRuntimeStore({ database, initialize: false });
  const clock = scheduleClock();
  const errors: unknown[] = [];
  const service = createAgentScheduleService({
    sqlite,
    ...clock,
    dispatch: () => undefined,
    onError: (e) => {
      errors.push(e);
    },
  });
  try {
    service.start();
    expect(clock.delays).toEqual([1_000]);
    for (let i = 0; i < 100; i++) await service.tick();
    expect(reads).toBe(1);
    expect(errors).toHaveLength(1);
    expect(clock.timers.size).toBe(1);
    clock.advance(1_000);
    await service.tick();
    expect(clock.delays.at(-1)).toBe(2_000);
    failures = false;
    clock.advance(2_000);
    clock.fire();
    await service.tick();
    expect(clock.timers.size).toBe(0);
    expect(writes).toBe(0);
  } finally {
    service.close();
    await sqlite.close();
    await owner.close();
  }
});

test('indexed hot path remains bounded with 100k schedules and a million events', async () => {
  const sqlite = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
  const clock = scheduleClock();
  let calls = 0;
  const service = createAgentScheduleService({
    sqlite,
    ...clock,
    dispatch: () => {
      calls++;
    },
  });
  try {
    sqlite.database.exec(`
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000)
      INSERT INTO stitchkit_agent_runtime_schedules
      (id, conversation_id, kind, next_at, input_payload, state, created_at, updated_at)
      SELECT 's'||x, 'scale', 'at', '2026-09-26T00:00:00.000Z', '{}',
        CASE WHEN x<=40 THEN 'scheduled' ELSE 'completed' END,
        '2026-09-26T00:00:00.000Z', '2026-09-26T00:00:00.000Z' FROM n;
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000)
      INSERT INTO stitchkit_agent_runtime_events
      (conversation_id, seq, event_id, schema_version, kind, occurred_at, payload)
      SELECT 'history', x, 'event-'||x, 1, 'schedule/failed', '2026-09-26T00:00:00.000Z', '{}' FROM n;
    `);
    for (const query of [
      "SELECT eligible_at FROM stitchkit_agent_runtime_schedules WHERE state = 'scheduled' ORDER BY eligible_at, id LIMIT 1",
      "SELECT * FROM stitchkit_agent_runtime_schedules WHERE state = 'scheduled' AND eligible_at <= '2026-09-26T00:00:00.000Z' ORDER BY eligible_at, id LIMIT 32",
    ]) {
      const plan = JSON.stringify(
        sqlite.database.prepare(`EXPLAIN QUERY PLAN ${query}`).all(),
      );
      expect(plan).toContain('USING INDEX stitchkit_agent_runtime_schedules_due');
      expect(plan).not.toContain('TEMP B-TREE');
      expect(plan).not.toContain('runtime_events');
    }
    await service.tick();
    expect(calls).toBe(32);
    await service.tick();
    expect(calls).toBe(40);
    const changes = sqlite.database.prepare('SELECT total_changes() AS count').get();
    for (let i = 0; i < 10; i++) await service.tick();
    expect(sqlite.database.prepare('SELECT total_changes() AS count').get()).toEqual(changes);
    expect(clock.timers.size).toBe(0);
  } finally {
    service.close();
    await sqlite.close();
  }
}, 20_000);

test('every coalesces decades of missed millisecond slots in constant arithmetic', async () => {
  const sqlite = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
  const clock = scheduleClock();
  let calls = 0;
  const service = createAgentScheduleService({
    sqlite,
    ...clock,
    dispatch: () => {
      calls++;
    },
  });
  try {
    await service.scheduleInput({
      conversationId: 'coalesce',
      input: {},
      everyMs: 1,
      timeZone: 'UTC',
    });
    clock.advance(1_000_000_000_000);
    await service.tick();
    expect(calls).toBe(1);
    expect(service.listSchedules('coalesce')[0]?.nextAt).toBe(
      new Date(clock.now().getTime() + 1).toISOString(),
    );
  } finally {
    service.close();
    await sqlite.close();
  }
});
