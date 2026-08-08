import { describe, expect, test } from 'bun:test';
import type { RequestEvent } from '../src/observability';
import { createObservability, setRequestError } from '../src/observability';
import { createHandler } from '../src/server';

describe('audit — structured error detail', () => {
  test('setRequestError({ details }) flows onto RequestEvent.errorDetail', async () => {
    const events: RequestEvent[] = [];
    const audit = createObservability({
      request: { write: (e) => void events.push(e) },
    });

    // Innermost handler records a structured error, as a project's onError would.
    const handler = createHandler({
      observability: audit.request,
      rawRoutes: [
        {
          method: 'POST',
          path: '/items',
          handler: () => {
            setRequestError({
              code: 'VALIDATION_ERROR',
              message: 'name: Required',
              details: { issues: [{ path: 'name', message: 'Required' }] },
            });
            return new Response(JSON.stringify({ error: { code: 'VALIDATION_ERROR' } }), {
              status: 400,
              headers: { 'content-type': 'application/json' },
            });
          },
        },
      ],
    });

    const res = await handler(new Request('http://localhost/items', { method: 'POST' }));
    expect(res.status).toBe(400);

    // The sink runs detached — yield until it has emitted.
    await Bun.sleep(10);

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.ok).toBe(false);
    expect(event?.errorCode).toBe('VALIDATION_ERROR');
    expect(event?.errorDetail).toEqual({ issues: [{ path: 'name', message: 'Required' }] });
  });

  test('a success carries no errorDetail', async () => {
    const events: RequestEvent[] = [];
    const audit = createObservability({
      request: { write: (e) => void events.push(e) },
    });
    const handler = createHandler({
      observability: audit.request,
      rawRoutes: [{ method: 'GET', path: '/items', handler: () => new Response('{}') }],
    });

    await handler(new Request('http://localhost/items'));
    await Bun.sleep(10);

    expect(events[0]?.ok).toBe(true);
    expect(events[0]?.errorDetail).toBeUndefined();
  });
});
