/**
 * Restart, against the resources the framework itself ships.
 *
 * Every case in `application-restart.test.ts` uses a hand-written fixture, and a
 * fixture is a resource that agrees with whatever the kernel does — it publishes
 * what the test wants and holds no state the test did not put there. That is the
 * wrong instrument for asking whether a restart *works*, and it said yes while a
 * managed schedule could not be restarted at all, a keyspace came back refusing
 * every write while reporting itself healthy, and a managed server was
 * republished after being shut down.
 *
 * So these drive the real ones.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createApplication } from '../src/application/kernel';
import {
  defineKeyspace,
  keyspaceResource,
  memoryKeyspaceBackend,
} from '../src/application/keyspace';
import type { ManagedResource } from '../src/application/resource';
import {
  createManagedSchedule,
  type ManagedScheduleClock,
  type ManagedScheduleTimer,
} from '../src/application/schedule';
import { managedServerResource } from '../src/application/server-resource';
import type { ManagedServerHandle, ShutdownResult } from '../src/server/shutdown';

/** The whole handle, so the type is satisfied by a fake rather than a cast. */
function fakeServer(onShutdown: () => void): ManagedServerHandle<null> {
  return {
    url: 'http://localhost:0',
    port: 0,
    runtime: null,
    status: {
      state: 'running',
      acceptedRequests: 0,
      completedRequests: 0,
      pendingRequests: 0,
      pendingWebSockets: 0,
    },
    async shutdown(): Promise<ShutdownResult> {
      onShutdown();
      return {
        outcome: 'clean',
        acceptedRequests: 0,
        completedRequests: 0,
        pendingRequests: 0,
        pendingWebSockets: 0,
        pendingRequestsAtForce: 0,
        pendingWebSocketsAtForce: 0,
        abortedRequests: 0,
        forcedWebSockets: 0,
        durationMs: 0,
      };
    },
  };
}

class TestClock implements ManagedScheduleClock {
  private current = 0;
  private sequence = 0;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();
  now(): number {
    return this.current;
  }
  wallNow(): Date {
    return new Date(Date.parse('2026-09-03T00:00:00.000Z') + this.current);
  }
  schedule(callback: () => void, delayMs: number): ManagedScheduleTimer {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.current + delayMs, callback });
    return { cancel: () => this.timers.delete(id) };
  }
  async advanceBy(deltaMs: number): Promise<void> {
    this.current += deltaMs;
    for (const [id, entry] of [...this.timers]) {
      if (entry.at > this.current) continue;
      this.timers.delete(id);
      entry.callback();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

describe('a managed schedule survives a restart', () => {
  test('a standalone schedule restarts instead of refusing', async () => {
    const clock = new TestClock();
    const schedule = createManagedSchedule({
      id: 'ticker',
      everyMs: 1_000,
      clock,
      run: () => {
        // The cadence is what these cases measure, not the work.
      },
    });
    const application = createApplication({ id: 'sched', resources: [schedule] });
    await application.start();

    const result = await application.restart({ resourceId: 'ticker' });

    expect(result.outcome).toBe('restarted');
    const record = application.getSnapshot().resources.find((r) => r.id === 'ticker');
    expect(record?.state).toBe('ready');
    expect(record?.health).toBe('healthy');
    await application.shutdown();
  });

  test('a restarted schedule runs again — it is armed, not merely constructed', async () => {
    const clock = new TestClock();
    const runs: number[] = [];
    const schedule = createManagedSchedule({
      id: 'ticker',
      everyMs: 1_000,
      clock,
      run: () => {
        runs.push(clock.now());
      },
    });
    const application = createApplication({ id: 'sched-ticks', resources: [schedule] });
    await application.start();
    await clock.advanceBy(1_000);
    expect(runs).toHaveLength(1);

    await application.restart({ resourceId: 'ticker' });
    await clock.advanceBy(1_000);

    // The assertion that matters. A schedule that came back `ready` but never
    // armed its timer reports perfect health and silently stops doing the one
    // thing it exists to do.
    expect(runs).toHaveLength(2);
    await application.shutdown();
  });

  test('a schedule under a restarted dependency comes back too', async () => {
    const clock = new TestClock();
    const database: ManagedResource = { id: 'database', start: () => ({ value: { n: 1 } }) };
    const schedule = createManagedSchedule({
      id: 'ticker',
      everyMs: 1_000,
      clock,
      dependsOn: ['database'],
      run: () => {
        // The cadence is what these cases measure, not the work.
      },
    });
    const application = createApplication({
      id: 'sched-dep',
      resources: [database, schedule],
    });
    await application.start();

    const result = await application.restart({ resourceId: 'database' });

    expect(result.outcome).toBe('restarted');
    expect(result.affected).toEqual(['database', 'ticker']);
    await application.shutdown();
  });
});

describe('a keyspace survives a restart', () => {
  const declaration = defineKeyspace('rooms', {
    schema: z.object({ id: z.string(), n: z.number() }),
    key: (value) => value.id,
  });

  test('writes are accepted again, and the records are the durable ones', async () => {
    const backend = memoryKeyspaceBackend();
    const keyspace = keyspaceResource(declaration, { backend });
    const seen: { put(v: { id: string; n: number }): Promise<void>; size: number }[] = [];
    const writer: ManagedResource = {
      id: 'writer',
      dependsOn: [keyspace.id],
      start(context) {
        seen.push(context.use(keyspace) as never);
      },
    };
    const application = createApplication({ id: 'ks', resources: [keyspace, writer] });
    await application.start();
    await seen[0]?.put({ id: 'a', n: 1 });

    const result = await application.restart({ resourceId: keyspace.id });

    expect(result.outcome).toBe('restarted');
    const after = seen[1];
    expect(after).toBeDefined();
    // Loaded from the backend, not carried over in memory.
    expect(after?.size).toBe(1);
    // And open. This rejected with "is shutting down" while the snapshot said
    // `ready` / `healthy` — the shape of failure that teaches people to stop
    // trusting the snapshot.
    await after?.put({ id: 'b', n: 2 });
    expect(after?.size).toBe(2);
    await application.shutdown();
  });

  test('a backend factory hands each generation its own backend', async () => {
    let built = 0;
    const keyspace = keyspaceResource(declaration, {
      backend: () => {
        built += 1;
        return memoryKeyspaceBackend();
      },
    });
    const application = createApplication({ id: 'ks-factory', resources: [keyspace] });
    await application.start();
    expect(built).toBe(1);

    await application.restart({ resourceId: keyspace.id });

    expect(built).toBe(2);
    await application.shutdown();
  });
});

describe('a managed server says what it cannot do', () => {
  test('given an instance rather than a factory, a restart is refused by name', async () => {
    let shutdowns = 0;
    const resource = managedServerResource({
      id: 'web',
      server: fakeServer(() => {
        shutdowns += 1;
      }),
    });
    const application = createApplication({ id: 'srv', resources: [resource] });
    await application.start();

    const result = await application.restart({ resourceId: 'web' });

    // Refused loudly rather than republishing the handle it just shut down —
    // which is the dead handle the whole subtree rule exists to prevent.
    expect(result.outcome).toBe('failed');
    expect(result.reason).toContain('cannot be restarted');
    expect(result.reason).toContain('factory');
    expect(shutdowns).toBe(1);
    await application.shutdown();
  });

  test('given a factory, each generation gets its own server', async () => {
    const built: number[] = [];
    const resource = managedServerResource({
      id: 'web',
      server: () => {
        built.push(built.length + 1);
        return fakeServer(() => {
          // This case counts builds, not stops.
        });
      },
    });
    const application = createApplication({ id: 'srv-factory', resources: [resource] });
    await application.start();

    const result = await application.restart({ resourceId: 'web' });

    expect(result.outcome).toBe('restarted');
    expect(built).toEqual([1, 2]);
    await application.shutdown();
  });

  test('the server built by the restart is the one the shutdown stops', async () => {
    const stopped: number[] = [];
    let generation = 0;
    const resource = managedServerResource({
      id: 'web',
      server: () => {
        generation += 1;
        const mine = generation;
        return fakeServer(() => stopped.push(mine));
      },
    });
    const application = createApplication({ id: 'srv-shutdown', resources: [resource] });
    await application.start();

    await application.restart({ resourceId: 'web' });
    await application.shutdown();

    // Generation 1 stopped during the restart, generation 2 on the way down.
    //
    // The adapter memoises its shutdown so that `stopAdmission`, `drain` and
    // `close` are one shutdown rather than three. Carried across a restart, that
    // memo answers for a server that is already gone: `close` returns it without
    // ever asking the new one to stop, and the restarted server outlives the
    // application that owns it, still holding its port. Counting builds cannot
    // see that — only counting stops can.
    expect(stopped).toEqual([1, 2]);
  });
});
