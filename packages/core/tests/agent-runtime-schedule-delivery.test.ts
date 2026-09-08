import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createAgentScheduleService } from '../src/agent-runtime';
import {
  createSqliteAgentRuntimeStore,
  type SqliteDatabase,
  type SqliteValue,
} from '../src/agent-runtime-sqlite-bun';

function sqlite(): SqliteDatabase {
  const raw = new Database(':memory:');
  return {
    exec: (sql) => raw.exec(sql),
    prepare(sql) {
      const statement = raw.query(sql);
      return {
        get: (...parameters: SqliteValue[]) => statement.get(...parameters),
        all: (...parameters: SqliteValue[]) => statement.all(...parameters),
        run: (...parameters: SqliteValue[]) => ({
          changes: statement.run(...parameters).changes,
        }),
      };
    },
    close: () => raw.close(),
  };
}

function fixture(
  dispatch: (delivery: {
    schedule: { id: string; occurrence: number };
  }) => Promise<void> | void,
) {
  const database = sqlite();
  const runtime = createSqliteAgentRuntimeStore({ database });
  let current = new Date('2026-09-08T01:00:00.000Z');
  let armed = 0;
  const schedules = createAgentScheduleService({
    sqlite: runtime,
    dispatch,
    now: () => current,
    setTimer: () => {
      armed += 1;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => undefined,
  });
  return {
    database,
    runtime,
    schedules,
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms);
    },
    armed: () => armed,
    kinds: async (conversationId: string) =>
      (await runtime.store.readEvents({ conversationId, limit: 50 })).items.map((e) => e.kind),
  };
}

describe('schedule delivery', () => {
  test('two ticks over one due row fire it once', async () => {
    const gate = Promise.withResolvers<void>();
    const deliveries: number[] = [];
    const f = fixture(async (delivery) => {
      deliveries.push(delivery.schedule.occurrence);
      await gate.promise;
    });
    await f.schedules.scheduleInput({
      conversationId: 's',
      input: { wake: true },
      afterMs: 10,
    });
    f.advance(1_000);
    // A re-arm from `scheduleInput`/`cancelSchedule` used to start a second
    // tick while the first still awaited `dispatch`, and both read the same
    // row with the same occurrence.
    const first = f.schedules.tick();
    const second = f.schedules.tick();
    gate.resolve();
    await Promise.all([first, second]);
    await f.schedules.tick();
    expect(deliveries).toEqual([1]);
    expect((await f.kinds('s')).filter((kind) => kind === 'schedule/fired')).toHaveLength(1);
    f.schedules.close();
    await f.runtime.close();
  });

  test('two processes over one file fire a due row once', async () => {
    // Two services on the same database stand in for two processes: neither
    // knows the other's in-flight tick, so only the durable claim can keep
    // one occurrence from being delivered twice.
    const deliveries: string[] = [];
    const database = sqlite();
    const runtime = createSqliteAgentRuntimeStore({ database });
    let current = new Date('2026-09-08T01:00:00.000Z');
    const gate = Promise.withResolvers<void>();
    const service = (name: string) =>
      createAgentScheduleService({
        sqlite: runtime,
        dispatch: async (delivery) => {
          deliveries.push(`${name}:${delivery.schedule.occurrence}`);
          await gate.promise;
        },
        now: () => current,
        setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
        clearTimer: () => undefined,
      });
    const a = service('a');
    const b = service('b');
    await a.scheduleInput({ conversationId: 's', input: { wake: true }, afterMs: 10 });
    current = new Date(current.getTime() + 1_000);
    const first = a.tick();
    const second = b.tick();
    gate.resolve();
    await Promise.all([first, second]);
    expect(deliveries).toHaveLength(1);
    a.close();
    b.close();
    await runtime.close();
  });

  test('a dispatch that throws is recorded, leaves the row due, and the timer alive', async () => {
    let attempts = 0;
    const f = fixture(() => {
      attempts += 1;
      if (attempts === 1) throw new Error('consumer down');
    });
    await f.schedules.scheduleInput({
      conversationId: 's',
      input: { wake: true },
      afterMs: 10,
    });
    const armedBefore = f.armed();
    f.advance(1_000);
    await f.schedules.tick();
    expect(await f.kinds('s')).toContain('schedule/failed');
    expect(f.armed()).toBeGreaterThan(armedBefore);
    await f.schedules.tick();
    expect(attempts).toBe(2);
    expect((await f.kinds('s')).filter((kind) => kind === 'schedule/fired')).toHaveLength(1);
    f.schedules.close();
    await f.runtime.close();
  });

  test('every fires once after sleeping through several intervals', async () => {
    const deliveries: number[] = [];
    const f = fixture((delivery) => {
      deliveries.push(delivery.schedule.occurrence);
    });
    await f.schedules.scheduleInput({
      conversationId: 's',
      input: { repeat: true },
      everyMs: 1_000,
      timeZone: 'Asia/Bangkok',
    });
    f.advance(3_500);
    await f.schedules.tick();
    expect(deliveries).toEqual([1]);
    const [schedule] = f.schedules.listSchedules('s');
    expect(new Date(schedule?.nextAt ?? 0).getTime()).toBeGreaterThan(
      new Date('2026-09-08T01:00:03.500Z').getTime(),
    );
    f.schedules.close();
    await f.runtime.close();
  });

  test('a cancellation during dispatch stands, and the row is not written back to scheduled', async () => {
    const gate = Promise.withResolvers<void>();
    const f = fixture(async () => {
      await gate.promise;
    });
    const service = f.schedules;
    const recurring = await service.scheduleInput({
      conversationId: 's',
      input: { repeat: true },
      everyMs: 1_000,
      timeZone: 'Asia/Bangkok',
    });
    f.advance(1_500);
    const firing = service.tick();
    expect(await service.cancelSchedule('s', recurring.id)).toBeTrue();
    gate.resolve();
    await firing;
    expect(service.listSchedules('s').map((schedule) => schedule.state)).toEqual([
      'cancelled',
    ]);
    const fired = (
      await f.runtime.store.readEvents({ conversationId: 's', limit: 20 })
    ).items.find((event) => event.kind === 'schedule/fired');
    expect(fired?.payload).toMatchObject({ state: 'cancelled' });
    f.schedules.close();
    await f.runtime.close();
  });

  test('a row another process holds is armed for the end of its claim, not for now', async () => {
    const database = sqlite();
    const runtime = createSqliteAgentRuntimeStore({ database });
    let current = new Date('2026-09-08T01:00:00.000Z');
    const delays: number[] = [];
    const gate = Promise.withResolvers<void>();
    const service = (dispatch: () => Promise<void>) =>
      createAgentScheduleService({
        sqlite: runtime,
        dispatch,
        now: () => current,
        setTimer: (_callback, delayMs) => {
          delays.push(delayMs);
          return 0 as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimer: () => undefined,
      });
    const holder = service(() => gate.promise);
    const bystander = service(async () => undefined);
    await holder.scheduleInput({ conversationId: 's', input: { wake: true }, afterMs: 10 });
    current = new Date(current.getTime() + 1_000);
    const holding = holder.tick();
    // The bystander arms while the holder's claim is open: the delay it picks
    // is the claim's remaining life, not zero — a zero re-armed every ~1.5 ms.
    delays.length = 0;
    await bystander.tick();
    expect(delays.length).toBe(1);
    expect(delays[0]).toBeGreaterThan(1_000);
    gate.resolve();
    await holding;
    holder.close();
    bystander.close();
    await runtime.close();
  });

  test("a tick's own failure reaches onError and does not end the loop", async () => {
    // The claim statement fails once — a store hiccup — and the loop must
    // report it and go on, not die as an unhandled rejection.
    const raw = sqlite();
    let claimFailures = 1;
    const database: SqliteDatabase = {
      ...raw,
      prepare(sql) {
        if (claimFailures > 0 && sql.includes('claim_owner = ?, claim_until = ?')) {
          claimFailures -= 1;
          throw new Error('injected store failure');
        }
        return raw.prepare(sql);
      },
    };
    const runtime = createSqliteAgentRuntimeStore({ database });
    let current = new Date('2026-09-08T01:00:00.000Z');
    const errors: unknown[] = [];
    let armed = 0;
    const deliveries: number[] = [];
    const schedules = createAgentScheduleService({
      sqlite: runtime,
      dispatch: (delivery) => {
        deliveries.push(delivery.schedule.occurrence);
      },
      now: () => current,
      setTimer: () => {
        armed += 1;
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => undefined,
      onError: (error) => {
        errors.push(error);
      },
    });
    await schedules.scheduleInput({ conversationId: 's', input: { wake: true }, afterMs: 10 });
    current = new Date(current.getTime() + 1_000);
    const before = armed;
    await schedules.tick();
    expect(errors.map((error) => (error as Error).message)).toEqual([
      'injected store failure',
    ]);
    expect(armed).toBeGreaterThan(before);
    await schedules.tick();
    expect(deliveries).toEqual([1]);
    schedules.close();
    await runtime.close();
  });
});
