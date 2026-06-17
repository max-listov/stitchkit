import { describe, expect, test } from 'bun:test';
import type { RequestEvent } from '../src/observability';
import { createAuditHook, setRequestError, wrapInRequestContext } from '../src/observability';

describe('audit — structured error detail', () => {
  test('setRequestError({ details }) flows onto RequestEvent.errorDetail', async () => {
    const events: RequestEvent[] = [];
    const audit = createAuditHook({ write: (e) => void events.push(e) });

    // Innermost handler records a structured error, as a project's onError would.
    const handler = async () => {
      setRequestError({
        code: 'VALIDATION_ERROR',
        message: 'name: Required',
        details: { issues: [{ path: 'name', message: 'Required' }] },
      });
      return new Response(JSON.stringify({ error: { code: 'VALIDATION_ERROR' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    };

    const wrapped = wrapInRequestContext(audit.http(handler));
    const res = await wrapped(
      new Request('http://localhost/items', { method: 'POST' }),
      undefined,
    );
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
    const audit = createAuditHook({ write: (e) => void events.push(e) });
    const handler = async () => new Response('{}', { status: 200 });

    const wrapped = wrapInRequestContext(audit.http(handler));
    await wrapped(new Request('http://localhost/items'), undefined);
    await Bun.sleep(10);

    expect(events[0]?.ok).toBe(true);
    expect(events[0]?.errorDetail).toBeUndefined();
  });
});
