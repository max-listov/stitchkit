import { expect, test } from 'bun:test';
import {
  createApplicationHealthHandler,
  createApplicationOperationalHandlers,
} from '../src/application/health';
import { createApplication } from '../src/application/kernel';

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
