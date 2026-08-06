import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract, type RuntimeContext } from '../src/contract';
import { createServer, implement, type MethodDef, type StitchLogger } from '../src/server';

// A param route with a body schema — a validation failure happens BEFORE
// `beforeHandle`, so it exercises the error path where the context used to be
// empty (no params, no request).
const items = defineContract(
  { prefix: 'items' },
  {
    update: {
      method: 'POST',
      path: '/:id',
      desc: 'Update an item',
      params: z.object({ id: z.string() }),
      input: z.object({ name: z.string() }),
      output: z.object({ id: z.string(), name: z.string() }),
    },
  },
);

const service = implement(items, {
  update: (ctx) => ({ id: ctx.params.id, name: ctx.input.name }),
});

describe('error context on a pre-handler (validation) failure', () => {
  let server: ReturnType<typeof createServer> | undefined;
  afterEach(() => server?.stop());

  test('onError still receives the path params, the request and the endpoint', async () => {
    let captured: { ctx: RuntimeContext; endpoint?: MethodDef } | undefined;
    const PORT = 9971;
    server = createServer({
      services: [service],
      port: PORT,
      hooks: {
        onError: (ctx, _err, endpoint) => {
          captured = { ctx, endpoint };
        },
      },
    });

    // Invalid body (`name` missing) → validation fails before beforeHandle.
    const res = await fetch(`http://localhost:${PORT}/items/abc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wrong: 'field' }),
    });
    expect(res.status).toBe(400);

    expect(captured).toBeDefined();
    // The path param is a property of the URL — known the moment the route
    // matched, so it is on the context even though body validation threw.
    expect((captured?.ctx.params as { id: string }).id).toBe('abc');
    // The raw request / url are first-class, typed, and reachable cast-free.
    expect(captured?.ctx.req).toBeInstanceOf(Request);
    expect(captured?.ctx.url).toBeInstanceOf(URL);
    expect(captured?.ctx.req?.method).toBe('POST');
    // The matched endpoint identity is passed through.
    expect(captured?.endpoint?.key).toBe('update');
    expect(captured?.endpoint?.serviceName).toBe('items');
  });

  test('the access log renders the error code on a validation failure', async () => {
    const lines: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const logger: StitchLogger = {
      info: (msg, fields) => lines.push({ msg, fields }),
      warn: (msg, fields) => lines.push({ msg, fields }),
      error: (msg, fields) => lines.push({ msg, fields }),
      debug: () => {
        // not asserted
      },
    };
    server = createServer({ services: [service], port: 0, logging: { logger } });
    const PORT = server.port;

    const res = await fetch(`http://localhost:${PORT}/items/abc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wrong: 'field' }),
    });
    expect(res.status).toBe(400);

    const done = lines.find((l) => l.fields?.status === 400);
    expect(done).toBeDefined();
    expect(done?.fields?.errorCode).toBe('VALIDATION_ERROR');
    expect(done?.msg).toContain('VALIDATION_ERROR');
  });

  test('the error code is logged even when onError returns its own Response', async () => {
    const lines: Array<{ fields?: Record<string, unknown> }> = [];
    const logger: StitchLogger = {
      info: (_m, fields) => lines.push({ fields }),
      warn: (_m, fields) => lines.push({ fields }),
      error: (_m, fields) => lines.push({ fields }),
      debug: () => {
        // not asserted
      },
    };
    server = createServer({
      services: [service],
      port: 0,
      logging: { logger },
      // A consuming project's custom error envelope — the framework no longer
      // produces the response, but the access log must still carry the code.
      hooks: { onError: () => new Response('{"e":1}', { status: 400 }) },
    });
    const PORT = server.port;

    const res = await fetch(`http://localhost:${PORT}/items/abc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wrong: 'field' }),
    });
    expect(res.status).toBe(400);

    const done = lines.find((l) => l.fields?.status === 400);
    expect(done?.fields?.errorCode).toBe('VALIDATION_ERROR');
  });
});
