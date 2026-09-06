import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import {
  createObservability,
  type RequestEvent,
  setRequestDimensions,
} from '../src/observability';
import { createHandler, implement } from '../src/server';

const items = defineContract(
  { prefix: 'items' },
  {
    get: {
      method: 'GET',
      path: '/:id',
      desc: 'Get an item',
      params: z.object({ id: z.string() }),
      output: z.object({ id: z.string() }),
    },
    create: {
      method: 'POST',
      path: '/',
      desc: 'Create an item',
      input: z.object({ name: z.string() }),
      output: z.object({ id: z.string() }),
    },
  },
);

const service = implement(items, {
  get: (ctx) => ({ id: ctx.params.id }),
  create: (ctx) => ({ id: ctx.input.name }),
});

/** A server fetch that audits every request and stamps a domain dimension from a
 *  header — in `beforeHandle` on success, in `onError` on a pre-handler failure. */
function build(events: RequestEvent[]) {
  const audit = createObservability({
    request: { write: (e) => void events.push(e) },
  });
  const handler = createHandler({
    services: [service],
    observability: audit.request,
    hooks: {
      beforeHandle: (ctx) => {
        const pid = ctx.req?.headers.get('x-project');
        if (pid) setRequestDimensions({ projectId: pid });
      },
      onError: (ctx) => {
        const pid = ctx.req?.headers.get('x-project');
        if (pid) setRequestDimensions({ projectId: pid });
        return undefined;
      },
    },
  });
  return handler;
}

describe('audit — endpoint identity (A) + domain dimensions (B)', () => {
  test('a successful request carries serviceName / action and the stamped dimension', async () => {
    const events: RequestEvent[] = [];
    const fetch = build(events);

    const res = await fetch(
      new Request('http://localhost/items/abc', { headers: { 'x-project': 'p1' } }),
      undefined,
    );
    expect(res.status).toBe(200);
    await Bun.sleep(10);

    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e?.ok).toBe(true);
    // Stable contract identity — not parsed from the path.
    expect(e?.serviceName).toBe('items');
    expect(e?.action).toBe('get');
    // Domain dimension stamped in beforeHandle.
    expect(e?.dimensions).toEqual({ projectId: 'p1' });
  });

  test('a validation failure still carries serviceName / action (bound before validation) and a dimension stamped in onError', async () => {
    const events: RequestEvent[] = [];
    const fetch = build(events);

    // Invalid body → validation fails before beforeHandle runs.
    const res = await fetch(
      new Request('http://localhost/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-project': 'p2' },
        body: JSON.stringify({ wrong: 'field' }),
      }),
      undefined,
    );
    expect(res.status).toBe(400);
    await Bun.sleep(10);

    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e?.ok).toBe(false);
    // Endpoint identity was bound at route-match, before the body was validated.
    expect(e?.serviceName).toBe('items');
    expect(e?.action).toBe('create');
    // beforeHandle never ran; the dimension was attributed in onError.
    expect(e?.dimensions).toEqual({ projectId: 'p2' });
  });

  test('a raw route may declare the same stable identity without deriving it from the path', async () => {
    const events: RequestEvent[] = [];
    const audit = createObservability({
      request: { write: (event) => void events.push(event) },
    });
    const fetch = createHandler({
      observability: audit.request,
      rawRoutes: [
        {
          method: 'POST',
          path: '/internal/rebuild/:id',
          serviceName: 'maintenance',
          action: 'rebuild',
          handler: () => new Response(null, { status: 204 }),
        },
      ],
    });

    expect(
      (
        await fetch(
          new Request('http://localhost/internal/rebuild/abc', { method: 'POST' }),
          undefined,
        )
      ).status,
    ).toBe(204);
    await Bun.sleep(10);

    expect(events[0]?.serviceName).toBe('maintenance');
    expect(events[0]?.action).toBe('rebuild');
  });

  test('a raw route can declare only serviceName for service-level policies', async () => {
    const events: RequestEvent[] = [];
    const audit = createObservability({
      request: { write: (event) => void events.push(event) },
    });
    const fetch = createHandler({
      observability: audit.request,
      rawRoutes: [
        {
          method: 'POST',
          path: '/internal/rebuild',
          serviceName: 'maintenance',
          handler: () => new Response(null, { status: 204 }),
        },
      ],
    });

    await fetch(
      new Request('http://localhost/internal/rebuild', { method: 'POST' }),
      undefined,
    );
    await Bun.sleep(10);

    expect(events[0]?.serviceName).toBe('maintenance');
    expect(events[0]?.action).toBeUndefined();
  });

  test('raw route identity is bound before a thrown handler error', async () => {
    const events: RequestEvent[] = [];
    const audit = createObservability({
      request: { write: (event) => void events.push(event) },
    });
    const fetch = createHandler({
      observability: audit.request,
      rawRoutes: [
        {
          method: 'POST',
          path: '/internal/fail',
          serviceName: 'maintenance',
          action: 'fail',
          handler: () => {
            throw new Error('private failure');
          },
        },
      ],
    });

    expect(
      (await fetch(new Request('http://localhost/internal/fail', { method: 'POST' }))).status,
    ).toBe(500);
    await Bun.sleep(10);

    expect(events[0]?.serviceName).toBe('maintenance');
    expect(events[0]?.action).toBe('fail');
    expect(events[0]?.ok).toBe(false);
  });
});
