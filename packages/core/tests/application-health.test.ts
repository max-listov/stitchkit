import { expect, test } from 'bun:test';
import { createApplicationHealthHandler } from '../src/application/health';
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
