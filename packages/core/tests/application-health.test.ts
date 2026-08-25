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
  });
  expect(ApplicationStatusProjectionSchema.parse(body)).toEqual(body);

  await app.shutdown();
});
