/**
 * Consumer code that runs before the dispatch `try` — `hooks.onRequest` and the
 * `traceId` resolver — must not be able to answer the request on its own. A
 * throw from either takes the normal path: the project's envelope for the hook,
 * the framework resolver for the id.
 */

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import type { StitchLogger } from '../src/server';
import { createHandler, implement } from '../src/server';

const ITEM = z.object({ id: z.string() });

function itemsService() {
  const contract = defineContract(
    { prefix: 'items' },
    { get: { method: 'GET', path: '/', desc: 'Get an item', output: ITEM } },
  );
  return implement(contract, { get: () => ({ id: '1' }) });
}

interface Line {
  fields: Record<string, unknown>;
}

function recordingLogger(lines: Line[]): StitchLogger {
  const push = (_msg: string, fields?: Record<string, unknown>) => {
    lines.push({ fields: fields ?? {} });
  };
  return { info: push, warn: push, error: push, debug: push };
}

function completions(lines: Line[]): Line[] {
  return lines.filter((l) => typeof l.fields.status === 'number');
}

describe('a throwing onRequest', () => {
  test('is answered with the framework envelope, CORS and a log line', async () => {
    const lines: Line[] = [];
    const handler = createHandler({
      services: [itemsService()],
      cors: { origin: 'https://app.example.com' },
      logging: { logger: recordingLogger(lines) },
      hooks: {
        onRequest: () => {
          throw new Error('gate exploded');
        },
      },
    });

    const res = await handler(
      new Request('http://x/items', { headers: { origin: 'https://app.example.com' } }),
    );

    expect(res.status).toBe(500);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    expect(res.headers.get('x-request-id')).toBeTruthy();
    // The framework's error shape, not whatever the runtime would have produced.
    expect(await res.json()).toMatchObject({ error: { code: 'INTERNAL_SERVER_ERROR' } });

    const done = completions(lines);
    expect(done).toHaveLength(1);
    expect(done[0]?.fields.status).toBe(500);
  });

  test('reaches onError, so the project envelope wins', async () => {
    const handler = createHandler({
      services: [itemsService()],
      hooks: {
        onRequest: () => {
          throw new Error('gate exploded');
        },
        onError: () => new Response(JSON.stringify({ mine: true }), { status: 503 }),
      },
    });

    const res = await handler(new Request('http://x/items'));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ mine: true });
  });

  test('an AppError thrown by the gate keeps its status', async () => {
    const { AppError } = await import('../src/contract');
    const handler = createHandler({
      services: [itemsService()],
      hooks: {
        onRequest: () => {
          throw new AppError('UNAUTHORIZED', 'no token', 401);
        },
      },
    });

    const res = await handler(new Request('http://x/items'));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });

  test('a hook that returns normally is unaffected', async () => {
    const handler = createHandler({
      services: [itemsService()],
      hooks: { onRequest: () => new Response('wall', { status: 418 }) },
    });
    const res = await handler(new Request('http://x/items'));
    expect(res.status).toBe(418);
    expect(await res.text()).toBe('wall');
  });
});

describe('a throwing traceId resolver', () => {
  test('does not cost the response — the framework resolver takes over', async () => {
    const handler = createHandler({
      services: [itemsService()],
      traceId: () => {
        throw new Error('no context');
      },
    });

    const res = await handler(new Request('http://x/items'));
    expect(res.status).toBe(200);
    const id = res.headers.get('x-request-id');
    expect(id).toBeTruthy();
    expect(id).not.toBe('undefined');
  });

  test('is reported once per handler, not once per request', async () => {
    const warnings: string[] = [];
    const noop = (): undefined => undefined;
    const handler = createHandler({
      services: [itemsService()],
      logging: {
        logger: { info: noop, error: noop, debug: noop, warn: (m) => void warnings.push(m) },
      },
      traceId: () => {
        throw new Error('no context');
      },
    });

    await handler(new Request('http://x/items'));
    await handler(new Request('http://x/items'));
    await handler(new Request('http://x/items'));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('`traceId` resolver threw');
    expect(warnings[0]).toContain('no context');
  });

  test('a throwing sink cannot turn that report into a failed request', async () => {
    const down = (): never => {
      throw new Error('sink down');
    };
    const handler = createHandler({
      services: [itemsService()],
      logging: { logger: { info: down, error: down, debug: down, warn: down } },
      traceId: () => {
        throw new Error('no context');
      },
    });

    const res = await handler(new Request('http://x/items'));
    expect(res.status).toBe(200);
  });

  test('a resolver that returns normally is still honoured', async () => {
    const handler = createHandler({
      services: [itemsService()],
      traceId: () => 'chosen-id',
    });
    const res = await handler(new Request('http://x/items'));
    expect(res.headers.get('x-request-id')).toBe('chosen-id');
  });
});
