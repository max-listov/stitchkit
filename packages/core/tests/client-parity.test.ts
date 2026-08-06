/**
 * Parity between the two client transports and the CORS exit path — the
 * divergences the 2026-07-09 audit found:
 *   1. an `onRequest` early Response must carry CORS like every other exit;
 *   2. the `HttpClient` (ky) client path must validate `output` — it used to
 *      return the body unvalidated, while the bare-fetch path validated.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createClient } from '../src/browser/client';
import { createHttpClient } from '../src/browser/http';
import { defineContract } from '../src/contract';
import { createHandler, createServer, implement } from '../src/server';

describe('onRequest early response carries CORS', () => {
  const ping = defineContract(
    { prefix: 'ping' },
    { get: { method: 'GET', path: '/', desc: 'Ping', output: z.object({ ok: z.boolean() }) } },
  );
  const service = implement(ping, { get: () => ({ ok: true }) });

  test('a short-circuit Response gets Access-Control-Allow-Origin', async () => {
    const handler = createHandler({
      services: [service],
      cors: { origin: '*' },
      hooks: { onRequest: () => new Response('maintenance', { status: 503 }) },
    });
    const res = await handler(
      new Request('http://x/ping', { headers: { Origin: 'http://app.example' } }),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});

describe('HttpClient path validates output', () => {
  let baseUrl = '';

  // The server answers with only `{ id }` …
  const serverContract = defineContract(
    { prefix: 'widgets' },
    { get: { method: 'GET', path: '/', desc: 'Get', output: z.object({ id: z.string() }) } },
  );
  const service = implement(serverContract, { get: () => ({ id: '1' }) });
  let server: ReturnType<typeof createServer>;

  // … the client expects `{ id, name }` — a name the server never sends.
  const strictContract = defineContract(
    { prefix: 'widgets' },
    {
      get: {
        method: 'GET',
        path: '/',
        desc: 'Get',
        output: z.object({ id: z.string(), name: z.string() }),
      },
    },
  );

  test('setup', () => {
    server = createServer({ services: [service], port: 0 });
    baseUrl = `http://localhost:${server.port}`;
  });

  test('the ky adapter path rejects a response that fails the output schema', async () => {
    const api = createClient(strictContract, createHttpClient({ baseUrl }));
    await expect(api.get()).rejects.toThrow();
  });

  test('a conforming response still resolves', async () => {
    const api = createClient(serverContract, createHttpClient({ baseUrl }));
    expect(await api.get()).toEqual({ id: '1' });
  });

  afterAll(() => server?.stop());
});
