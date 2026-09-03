/**
 * Replacing one resource and everything above it, with the rest still running.
 *
 * The assertions that carry this: an independent neighbour is **not touched**,
 * and no lifecycle hook of one generation runs twice. Both are about what does
 * *not* happen, which is why every resource here records its own phases — a
 * restart that quietly took the whole graph down would satisfy a test that only
 * checked the target came back.
 */
import { describe, expect, test } from 'bun:test';
import { createApplication } from '../src/application/kernel';
import type { ManagedResource } from '../src/application/resource';

/** A resource that writes down every phase it is put through. */
function recorded(
  id: string,
  log: string[],
  options: {
    dependsOn?: readonly string[];
    failStartAfter?: number;
    onStart?: () => void;
  } = {},
): ManagedResource {
  let starts = 0;
  return {
    id,
    ...(options.dependsOn && { dependsOn: options.dependsOn }),
    start() {
      starts += 1;
      log.push(`${id}:start`);
      options.onStart?.();
      if (options.failStartAfter !== undefined && starts > options.failStartAfter) {
        throw new Error(`${id} refuses to start again`);
      }
      return { value: { id, generation: starts } };
    },
    activate() {
      log.push(`${id}:activate`);
    },
    stopAdmission() {
      log.push(`${id}:stopAdmission`);
    },
    drain() {
      log.push(`${id}:drain`);
    },
    close() {
      log.push(`${id}:close`);
    },
  };
}

async function ready(resources: readonly ManagedResource[], log: string[]) {
  const application = createApplication({ id: 'restart-test', resources });
  await application.start();
  log.length = 0;
  return application;
}

describe('the unit is the subtree, not the resource', () => {
  test('restarting a leaf leaves an independent neighbour untouched', async () => {
    const log: string[] = [];
    const application = await ready(
      [recorded('database', log), recorded('cache', log), recorded('mailer', log)],
      log,
    );

    const result = await application.restart({ resourceId: 'cache' });

    expect(result.outcome).toBe('restarted');
    expect(result.affected).toEqual(['cache']);
    // The neighbour appears nowhere: not closed, not started, not activated.
    expect(log.filter((line) => line.startsWith('mailer'))).toEqual([]);
    expect(log.filter((line) => line.startsWith('database'))).toEqual([]);
    await application.shutdown();
  });

  test('restarting a dependency restarts what depends on it, transitively', async () => {
    const log: string[] = [];
    const application = await ready(
      [
        recorded('database', log),
        recorded('repository', log, { dependsOn: ['database'] }),
        recorded('api', log, { dependsOn: ['repository'] }),
        recorded('mailer', log),
      ],
      log,
    );

    const result = await application.restart({ resourceId: 'database' });

    expect(result.affected).toEqual(['database', 'repository', 'api']);
    expect(log.filter((line) => line.startsWith('mailer'))).toEqual([]);
    await application.shutdown();
  });

  test('the old generation is closed before the new one starts, in both orders', async () => {
    const log: string[] = [];
    const application = await ready(
      [recorded('database', log), recorded('api', log, { dependsOn: ['database'] })],
      log,
    );

    await application.restart({ resourceId: 'database' });

    // Closed top-down, started bottom-up, and no start before the last close.
    expect(log).toEqual([
      'api:stopAdmission',
      'api:drain',
      'api:close',
      'database:stopAdmission',
      'database:drain',
      'database:close',
      'database:start',
      'api:start',
      'database:activate',
      'api:activate',
    ]);
    await application.shutdown();
  });

  test('a dependant is handed the new value, not the closed one', async () => {
    const log: string[] = [];
    const seen: unknown[] = [];
    const database = recorded('database', log);
    const api: ManagedResource = {
      id: 'api',
      dependsOn: ['database'],
      start(context) {
        seen.push(context.use(database));
      },
    };
    const application = await ready([database, api], log);

    await application.restart({ resourceId: 'database' });

    expect(seen).toEqual([
      { id: 'database', generation: 1 },
      { id: 'database', generation: 2 },
    ]);
    await application.shutdown();
  });

  test('a generation that publishes nothing does not inherit the old value', async () => {
    const log: string[] = [];
    const seen: unknown[] = [];
    let generation = 0;
    // The case the previous test cannot reach: the new generation publishes
    // nothing, so there is no `set` to overwrite the old entry with. Erasing it
    // is the only thing standing between a dependant and a handle to a resource
    // that has been closed.
    const database: ManagedResource = {
      id: 'database',
      start() {
        generation += 1;
        log.push('database:start');
        return generation === 1 ? { value: { generation } } : undefined;
      },
      close() {
        log.push('database:close');
      },
    };
    const api: ManagedResource = {
      id: 'api',
      dependsOn: ['database'],
      start(context) {
        seen.push(context.use(database));
      },
    };
    const application = await ready([database, api], log);

    const result = await application.restart({ resourceId: 'database' });

    // Refused loudly rather than served a dead handle.
    expect(result.outcome).toBe('failed');
    expect(result.reason).toContain('published no value');
    expect(seen).toEqual([{ generation: 1 }]);
    await application.shutdown();
  });
});

describe('what a restart refuses to do', () => {
  test('an unknown resource is refused by name, and nothing is touched', async () => {
    const log: string[] = [];
    const application = await ready([recorded('database', log)], log);
    const result = await application.restart({ resourceId: 'nope' });
    expect(result.outcome).toBe('refused');
    expect(result.reason).toContain('"nope"');
    expect(log).toEqual([]);
    await application.shutdown();
  });

  test('a restart during shutdown is refused rather than racing it', async () => {
    const log: string[] = [];
    const application = await ready([recorded('database', log)], log);
    const stopping = application.shutdown();
    const result = await application.restart({ resourceId: 'database' });
    expect(result.outcome).toBe('refused');
    expect(result.reason).toContain('shutting down');
    await stopping;
  });

  test('a restart before the application is ready is refused', async () => {
    const log: string[] = [];
    const application = createApplication({
      id: 'not-started',
      resources: [recorded('database', log)],
    });
    const result = await application.restart({ resourceId: 'database' });
    expect(result.outcome).toBe('refused');
    expect(log).toEqual([]);
  });
});

describe('failure is reported, not hidden', () => {
  test('a resource that will not start again fails the restart and shows in the snapshot', async () => {
    const log: string[] = [];
    const application = await ready([recorded('database', log, { failStartAfter: 1 })], log);

    const result = await application.restart({ resourceId: 'database' });

    expect(result.outcome).toBe('failed');
    expect(result.reason).toContain('refuses to start again');
    // The snapshot agrees — a failure that only the return value knew about
    // would be invisible to everything that watches the application.
    const record = application
      .getSnapshot()
      .resources.find((entry) => entry.id === 'database');
    expect(record?.state).toBe('failed');
    expect(record?.health).toBe('unhealthy');
    await application.shutdown();
  });

  test('each generation is closed once — the old one now, the failed one later', async () => {
    const log: string[] = [];
    const application = await ready([recorded('database', log, { failStartAfter: 1 })], log);

    await application.restart({ resourceId: 'database' });
    // Once, for the generation that was running. Not twice: a second close of
    // the same generation is what a restart that forgot it had already closed
    // would produce.
    expect(log.filter((line) => line === 'database:close')).toHaveLength(1);

    log.length = 0;
    await application.shutdown();
    // And once more for the attempt that threw. `start` may have leaked before
    // it failed, so the kernel closes a failed resource on the way down — the
    // same convention a resource that fails during ordinary startup gets.
    expect(log).toEqual(['database:stopAdmission', 'database:drain', 'database:close']);
  });
});

describe('two restarts do not interleave', () => {
  test('concurrent calls run one after the other', async () => {
    const log: string[] = [];
    const application = await ready(
      [recorded('database', log), recorded('api', log, { dependsOn: ['database'] })],
      log,
    );

    const [first, second] = await Promise.all([
      application.restart({ resourceId: 'database' }),
      application.restart({ resourceId: 'database' }),
    ]);

    expect(first.outcome).toBe('restarted');
    expect(second.outcome).toBe('restarted');
    // Two complete passes, one after the other — asserted as the exact log
    // rather than as a property of it, because every way these two could
    // interleave produces some other sequence, and naming one property leaves
    // the rest unmeasured.
    const onePass = [
      'api:stopAdmission',
      'api:drain',
      'api:close',
      'database:stopAdmission',
      'database:drain',
      'database:close',
      'database:start',
      'api:start',
      'database:activate',
      'api:activate',
    ];
    expect(log).toEqual([...onePass, ...onePass]);
    await application.shutdown();
  });

  test('a restart after a restart sees the previous generation gone', async () => {
    const log: string[] = [];
    const application = await ready([recorded('database', log)], log);
    await application.restart({ resourceId: 'database' });
    log.length = 0;
    await application.restart({ resourceId: 'database' });
    expect(log).toEqual([
      'database:stopAdmission',
      'database:drain',
      'database:close',
      'database:start',
      'database:activate',
    ]);
    await application.shutdown();
  });
});

describe('the process outlives the restart', () => {
  test('the epoch is unchanged, because the process did not restart', async () => {
    const log: string[] = [];
    const application = await ready([recorded('database', log)], log);
    const before = application.getSnapshot().epoch;
    await application.restart({ resourceId: 'database' });
    expect(application.getSnapshot().epoch).toBe(before);
    await application.shutdown();
  });

  test('shutdown afterwards closes each generation once, not twice', async () => {
    const log: string[] = [];
    const application = await ready(
      [recorded('database', log), recorded('api', log, { dependsOn: ['database'] })],
      log,
    );
    await application.restart({ resourceId: 'database' });
    log.length = 0;
    await application.shutdown();
    expect(log.filter((line) => line.endsWith(':close')).sort()).toEqual([
      'api:close',
      'database:close',
    ]);
  });
});

describe('the result agrees with the snapshot', () => {
  test('an optional resource that will not start again makes the restart failed', async () => {
    const log: string[] = [];
    const application = await ready(
      [{ ...recorded('flaky', log, { failStartAfter: 1 }), required: false }],
      log,
    );

    const result = await application.restart({ resourceId: 'flaky' });

    // `startEach` re-throws only for a REQUIRED resource, so this path finished
    // normally and used to report `restarted` — success on the return value and
    // `failed` / `unhealthy` in the very next `getSnapshot()`. Two answers to
    // one question, and the caller reads the wrong one.
    expect(result.outcome).toBe('failed');
    expect(result.reason).toContain('flaky');
    const record = application.getSnapshot().resources.find((entry) => entry.id === 'flaky');
    expect(record?.state).toBe('failed');
    await application.shutdown();
  });

  test('a restart that comes back clean still reports restarted', async () => {
    const log: string[] = [];
    const application = await ready(
      [{ ...recorded('cache', log), required: false }, recorded('database', log)],
      log,
    );
    const result = await application.restart({ resourceId: 'cache' });
    // The negative control for the test above: the failed-record check must not
    // turn every optional restart into a failure.
    expect(result.outcome).toBe('restarted');
    await application.shutdown();
  });
});

describe('the close phase is bounded', () => {
  test('a drain that never finishes fails the restart instead of hanging it', async () => {
    const log: string[] = [];
    const stuck: ManagedResource = {
      id: 'stuck',
      start: () => ({ value: 1 }),
      drain: () =>
        new Promise<never>(() => {
          // Never resolved: that is the condition under test.
        }),
      close: () => {
        log.push('stuck:close');
      },
    };
    const application = createApplication({
      id: 'bounded-restart',
      resources: [stuck],
      shutdown: { gracePeriodMs: 20, forceTimeoutMs: 20 },
    });
    await application.start();

    // Raced, because the failure this covers is a hang: without a bound the
    // restart never settles, and a test that never returns cannot go red.
    const NEVER = Symbol('still restarting');
    const settled = await Promise.race([
      application.restart({ resourceId: 'stuck' }),
      new Promise((resolve) => setTimeout(() => resolve(NEVER), 2_000)),
    ]);

    expect(settled).not.toBe(NEVER);
    expect((settled as { outcome: string }).outcome).toBe('failed');
    expect((settled as { reason?: string }).reason).toContain('drain');
  });

  test('the call may name its own budget', async () => {
    const log: string[] = [];
    const stuck: ManagedResource = {
      id: 'stuck',
      start: () => ({ value: 1 }),
      drain: () =>
        new Promise<never>(() => {
          // Never resolved: that is the condition under test.
        }),
    };
    const application = createApplication({
      id: 'bounded-restart-arg',
      // Generous by default — so a budget that arrives only from the call is the
      // only thing that can end this in time.
      resources: [stuck],
      shutdown: { gracePeriodMs: 60_000, forceTimeoutMs: 60_000 },
    });
    await application.start();
    log.length = 0;

    const NEVER = Symbol('still restarting');
    const settled = await Promise.race([
      application.restart({ resourceId: 'stuck', gracePeriodMs: 20, forceTimeoutMs: 20 }),
      new Promise((resolve) => setTimeout(() => resolve(NEVER), 2_000)),
    ]);

    expect(settled).not.toBe(NEVER);
    expect((settled as { outcome: string }).outcome).toBe('failed');
  });
});
