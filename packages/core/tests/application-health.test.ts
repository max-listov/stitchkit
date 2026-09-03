import { expect, test } from 'bun:test';
import {
  createApplicationHealthHandler,
  createApplicationOperationalHandlers,
} from '../src/application/health';
import { createApplication } from '../src/application/kernel';
import { defineManagedResource } from '../src/application/resource';
import { ApplicationStatusProjectionSchema } from '../src/application/schemas';

test('application health handler reports readiness without exposing a second state model', async () => {
  const app = createApplication({ id: 'health' });
  const readiness = createApplicationHealthHandler(app, {
    kind: 'readiness',
    retryAfterSeconds: 7,
  });
  const before = readiness();
  expect(before.status).toBe(503);
  expect(before.headers.get('Retry-After')).toBe('7');

  await app.start();
  expect(readiness().status).toBe(200);
  await app.shutdown();
  expect(readiness().status).toBe(503);
});

test('application operational handlers compose status and existing probe semantics', async () => {
  const app = createApplication({ id: 'operational' });
  const handlers = createApplicationOperationalHandlers(app, { retryAfterSeconds: 3 });

  expect(handlers.status().status).toBe(200);
  expect(handlers.readiness().status).toBe(503);
  expect(handlers.liveness().status).toBe(200);

  await app.start();
  expect(handlers.readiness().status).toBe(200);
  await app.shutdown();

  const stopped = handlers.status();
  expect(stopped.status).toBe(200);
  expect((await stopped.json()).lifecycle).toBe('stopped');
  expect(handlers.liveness().status).toBe(503);
  expect(handlers.liveness().headers.get('Retry-After')).toBe('3');
});

test('a published response never carries the internal resource topology', async () => {
  // The snapshot names every resource, its dependency edges, the process epoch
  // and live admission counters. These handlers are documented for public
  // mounting, so none of that may leave the process through them.
  const app = createApplication({
    id: 'topology',
    resources: [
      defineManagedResource({ id: 'database', start: () => undefined }),
      defineManagedResource({ id: 'worker', dependsOn: ['database'], start: () => undefined }),
    ],
  });
  await app.start();
  const handlers = createApplicationOperationalHandlers(app);

  for (const response of [handlers.status(), handlers.readiness(), handlers.liveness()]) {
    const body = await response.text();
    expect(body).not.toContain('dependsOn');
    expect(body).not.toContain('database');
    expect(body).not.toContain('worker');
    expect(body).not.toContain('epoch');
    expect(body).not.toContain('accepted');
    expect(body).not.toContain('pending');
  }

  // The same facts remain fully available in-process.
  const snapshot = app.getSnapshot();
  expect(snapshot.resources.map((resource) => resource.id)).toEqual(['database', 'worker']);
  expect(snapshot.resources[1]?.dependsOn).toEqual(['database']);
  expect(snapshot.epoch).toBeString();

  await app.shutdown();
});

test('the published projection still answers the question a probe is asked', async () => {
  const app = createApplication({
    id: 'verdict',
    resources: [defineManagedResource({ id: 'only', start: () => undefined })],
  });
  await app.start();

  const body = await createApplicationOperationalHandlers(app).status().json();
  expect(body).toEqual({
    id: 'verdict',
    lifecycle: 'ready',
    health: 'healthy',
    ready: true,
    capturedAt: expect.any(String),
    resources: { total: 1, ready: 1, degraded: 0, failed: 0 },
    restarting: 0,
  });
  expect(ApplicationStatusProjectionSchema.parse(body)).toEqual(body);

  await app.shutdown();
});

test('a probe can tell a resource being replaced from one that broke', async () => {
  // The question this field exists to answer. Mid-restart the resource is not
  // `ready`, which reads on a dashboard exactly like a resource that failed on
  // its own — and the operator pages someone.
  let release: (() => void) | undefined;
  let blocked = false;
  const app = createApplication({
    id: 'replacing',
    resources: [
      // A second, unrelated resource — because the defect this test missed the
      // first time was graph-wide. With one resource in the graph, "the whole
      // application went unready" and "the resource being replaced went unready"
      // are the same observation.
      defineManagedResource({ id: 'unrelated', start: () => undefined }),
      defineManagedResource({
        id: 'slow',
        start: () => undefined,
        drain: () =>
          blocked
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                blocked = true;
                release = resolve;
              }),
      }),
    ],
  });
  await app.start();

  const status = () => createApplicationOperationalHandlers(app).status().json();
  expect((await status()).restarting).toBe(0);
  // Released, or shutdown waits on it forever and the test hangs on its own
  // bookkeeping rather than on anything it is measuring.
  app.admission.acquire()?.release();

  const restarting = app.restart({ resourceId: 'slow' });
  // Wait until the restart is actually inside `drain`, rather than assuming one
  // microtask gets it there — a test that guesses the schedule measures the
  // guess.
  const deadline = Date.now() + 2_000;
  while (release === undefined && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 5));
  expect(release).toBeDefined();
  const during = await status();
  expect(during.restarting).toBe(1);
  // And the snapshot names which ones, where the ids are not published.
  expect(app.getSnapshot().restarting).toEqual(['slow']);

  // The half this test was missing, and it is the half that matters.
  //
  // Naming the subtree is worthless if saying it costs the rest of the graph its
  // admission. A first attempt marked the affected records `stopping` so the
  // closing window would be visible per resource — and `isReady()` is a
  // graph-wide predicate over every record's state, so one leaf being replaced
  // made the whole application unready and unhealthy and `acquire()` returned
  // null. That is precisely the failure a `restarting` LIFECYCLE was rejected
  // for, arrived at through the other door.
  expect(during.ready).toBe(true);
  expect(during.health).toBe('healthy');
  const lease = app.admission.acquire();
  expect(lease).not.toBeNull();
  lease?.release();

  release?.();
  await restarting;
  expect((await status()).restarting).toBe(0);
  expect(app.getSnapshot().restarting).toEqual([]);

  await app.shutdown();
});
