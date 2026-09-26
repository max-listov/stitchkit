import { afterEach, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBunSqliteAgentRuntimeStore } from '../src/agent-runtime/sqlite-bun';
import { createAgentScheduleService } from '../src/entrypoints/agent-runtime';
import { scheduleClock } from './fixtures/schedule-clock';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanup.splice(0).reverse()) await clean();
});
function store(filename = ':memory:') {
  const sqlite = createBunSqliteAgentRuntimeStore({ filename });
  cleanup.push(() => sqlite.close());
  return sqlite;
}
function service(input: Parameters<typeof createAgentScheduleService>[0]) {
  const schedules = createAgentScheduleService(input);
  cleanup.push(() => schedules.close());
  return schedules;
}
async function events(sqlite: ReturnType<typeof store>) {
  return (await sqlite.store.readEvents({ conversationId: 'synthetic', limit: 100 })).items;
}

test('retry survives reopen, preserves key/due time, caps delay and resets after success', async () => {
  const filename = join(tmpdir(), `schedule-${crypto.randomUUID()}.sqlite`);
  cleanup.push(() => rmSync(filename, { force: true }));
  const clock = scheduleClock();
  let sqlite = createBunSqliteAgentRuntimeStore({ filename });
  let failure = true;
  const keys: string[] = [];
  const dispatch: Parameters<typeof createAgentScheduleService>[0]['dispatch'] = (request) => {
    keys.push(request.idempotencyKey);
    if (failure) return { status: 'retry', reason: 'temporarily unavailable' };
  };
  let scheduler = createAgentScheduleService({ sqlite, ...clock, dispatch });
  const schedule = await scheduler.scheduleInput({
    conversationId: 'synthetic',
    input: {},
    everyMs: 10,
    timeZone: 'UTC',
  });
  clock.advance(10);
  await scheduler.tick();
  expect(scheduler.listSchedules('synthetic')[0]).toMatchObject({
    nextAt: schedule.nextAt,
    attempts: 1,
  });
  scheduler.close();
  await sqlite.close();
  sqlite = store(filename);
  scheduler = service({ sqlite, ...clock, dispatch });
  scheduler.start();
  expect(clock.delays.at(-1)).toBe(1_000);
  const expected = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000];
  for (const delay of expected) {
    const count = keys.length;
    clock.advance(delay - 1);
    await scheduler.tick();
    expect(keys).toHaveLength(count);
    clock.advance(1);
    await scheduler.tick();
    expect(keys).toHaveLength(count + 1);
  }
  expect(new Set(keys).size).toBe(1);
  failure = false;
  clock.advance(60_000);
  await scheduler.tick();
  expect(scheduler.listSchedules('synthetic')[0]).toMatchObject({
    occurrence: 1,
    attempts: 0,
    state: 'scheduled',
  });
  expect(scheduler.listSchedules('synthetic')[0]?.retryAt).toBeUndefined();
  expect(scheduler.listSchedules('synthetic')[0]?.lastError).toBeUndefined();
  expect((await events(sqlite)).filter((e) => e.kind === 'schedule/failed')).toHaveLength(9);
});

test('terminal stops every; cancellation during failure emits no false settlement', async () => {
  const sqlite = store();
  const clock = scheduleClock();
  let calls = 0;
  const scheduler = service({
    sqlite,
    ...clock,
    dispatch: () => {
      calls++;
      return { status: 'terminal', reason: 'destination closed' };
    },
  });
  await scheduler.scheduleInput({
    conversationId: 'synthetic',
    input: {},
    everyMs: 1,
    timeZone: 'UTC',
  });
  clock.advance(1);
  await scheduler.tick();
  clock.advance(100_000);
  await scheduler.tick();
  expect(calls).toBe(1);
  expect(scheduler.listSchedules('synthetic')[0]).toMatchObject({
    state: 'failed',
    occurrence: 0,
    lastError: 'destination closed',
  });
  expect((await events(sqlite)).map((e) => e.kind)).toEqual([
    'schedule/set',
    'schedule/failed',
  ]);
  expect(clock.timers.size).toBe(0);
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const cancelling = service({
    sqlite,
    ...clock,
    dispatch: async () => {
      entered.resolve();
      await gate.promise;
      throw new Error('offline');
    },
  });
  const next = await cancelling.scheduleInput({
    conversationId: 'synthetic',
    input: {},
    afterMs: 1,
  });
  clock.advance(1);
  const tick = cancelling.tick();
  await entered.promise;
  await cancelling.cancelSchedule('synthetic', next.id);
  gate.resolve();
  await tick;
  expect((await events(sqlite)).map((e) => e.kind)).toEqual([
    'schedule/set',
    'schedule/failed',
    'schedule/set',
    'schedule/cancelled',
  ]);
});

test('hanging dispatch has a deadline while a healthy schedule delivers immediately', async () => {
  const sqlite = store();
  const clock = scheduleClock();
  const entered = Promise.withResolvers<void>();
  const healthy = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  const scheduler = service({
    sqlite,
    ...clock,
    dispatch: async (request) => {
      if (request.input === 'hang') {
        signal = request.signal;
        entered.resolve();
        await gate.promise;
      } else healthy.resolve();
    },
  });
  await scheduler.scheduleInput({ conversationId: 'synthetic', input: 'hang', afterMs: 1 });
  await scheduler.scheduleInput({
    conversationId: 'synthetic',
    input: 'healthy',
    at: new Date(clock.now().getTime() + 1).toISOString(),
  });
  clock.advance(1);
  const tick = scheduler.tick();
  await Promise.all([entered.promise, healthy.promise]);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  expect(
    scheduler.listSchedules('synthetic').filter((s) => s.state === 'completed'),
  ).toHaveLength(1);
  clock.advance(30_000);
  clock.fire();
  await tick;
  expect(signal?.aborted).toBeTrue();
  expect(
    scheduler
      .listSchedules('synthetic')
      .map((s) => s.state)
      .sort(),
  ).toEqual(['completed', 'scheduled']);
  const before = await events(sqlite);
  gate.resolve();
  await Promise.resolve();
  expect(await events(sqlite)).toEqual(before);
});

test.each(['success', 'failure'])(
  'expired lease and late %s cannot settle a newer occurrence',
  async (result) => {
    const filename = join(tmpdir(), `schedule-fence-${crypto.randomUUID()}.sqlite`);
    cleanup.push(() => rmSync(filename, { force: true }));
    const aStore = store(filename);
    const bStore = store(filename);
    const clock = scheduleClock();
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const admitted = new Set<string>();
    const a = service({
      sqlite: aStore,
      ...clock,
      dispatch: async (request) => {
        admitted.add(request.idempotencyKey);
        entered.resolve();
        await gate.promise;
        if (result === 'failure') throw new Error('late error');
      },
    });
    const b = service({
      sqlite: bStore,
      ...clock,
      dispatch: (request) => {
        admitted.add(request.idempotencyKey);
      },
    });
    await a.scheduleInput({
      conversationId: 'synthetic',
      input: {},
      everyMs: 1_000,
      timeZone: 'UTC',
    });
    clock.advance(1_000);
    const pending = a.tick();
    await entered.promise;
    // Simulate a paused process: its timers do not execute before the lease is taken over.
    clock.advance(60_000);
    await b.tick();
    expect(admitted.size).toBe(1);
    const before = await events(bStore);
    gate.resolve();
    await pending;
    expect(await events(bStore)).toEqual(before);
    expect(b.listSchedules('synthetic')[0]?.occurrence).toBe(1);
  },
);

test('crash after durable admission replays the key without adding another logical input', async () => {
  const filename = join(tmpdir(), `schedule-admission-${crypto.randomUUID()}.sqlite`);
  cleanup.push(() => rmSync(filename, { force: true }));
  const clock = scheduleClock();
  const firstStore = createBunSqliteAgentRuntimeStore({ filename });
  const admitted = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const createdAt = clock.now().toISOString();
  const accept = async (sqlite: ReturnType<typeof store>, idempotencyKey: string) => {
    await sqlite.store.acceptInputAndAssignRun({
      idempotencyKey,
      input: {
        schemaVersion: 1,
        id: 'scheduled-input',
        conversationId: 'synthetic',
        role: 'user',
        status: 'committed',
        parts: [{ type: 'text', text: 'synthetic reminder' }],
        createdAt,
        updatedAt: createdAt,
      },
      run: {
        schemaVersion: 1,
        id: 'scheduled-run',
        conversationId: 'synthetic',
        inputMessageIds: ['scheduled-input'],
        assistantMessageId: 'scheduled-assistant',
        state: 'queued',
        revision: 0,
        createdAt,
        updatedAt: createdAt,
      },
    });
  };
  const a = createAgentScheduleService({
    sqlite: firstStore,
    ...clock,
    dispatch: async (request) => {
      await accept(firstStore, request.idempotencyKey);
      admitted.resolve();
      await gate.promise;
    },
  });
  await a.scheduleInput({ conversationId: 'synthetic', input: {}, afterMs: 1 });
  clock.advance(1);
  const pending = a.tick();
  await admitted.promise;
  a.close();
  await pending;
  await firstStore.close();
  const secondStore = store(filename);
  const b = service({
    sqlite: secondStore,
    ...clock,
    dispatch: (request) => accept(secondStore, request.idempotencyKey),
  });
  clock.advance(60_000);
  await b.tick();
  gate.resolve();
  expect(
    (await secondStore.store.loadSnapshot('synthetic')).messages.map((m) => m.id),
  ).toEqual(['scheduled-input']);
  expect(b.listSchedules('synthetic')[0]?.state).toBe('completed');
  expect((await events(secondStore)).filter((e) => e.kind === 'schedule/fired')).toHaveLength(
    1,
  );
});
