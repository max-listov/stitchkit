import { afterAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { implement } from '../src/server/implement';
import { serveNode } from '../src/server/node';

const contract = defineContract(
  { prefix: '/api' },
  {
    ping: {
      method: 'GET',
      path: '/ping',
      desc: 'Health check',
      output: z.object({ pong: z.boolean() }),
    },
    echo: {
      method: 'POST',
      path: '/echo',
      desc: 'Echo message',
      input: z.object({ message: z.string() }),
      output: z.object({ message: z.string() }),
    },
  },
);

const service = implement(contract, {
  ping: () => ({ pong: true }),
  echo: (ctx) => ({ message: ctx.input.message }),
});

const server = await serveNode({
  services: [service],
  port: 0,
});

const base = `http://localhost:${server.port}`;

afterAll(() => server.close());

describe('serveNode', () => {
  test('GET returns JSON', async () => {
    const res = await fetch(`${base}/api/ping`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pong: true });
  });

  test('POST with body', async () => {
    const res = await fetch(`${base}/api/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: 'hello' });
  });

  test('404 for unknown path', async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });

  test('405 for wrong method', async () => {
    const res = await fetch(`${base}/api/ping`, { method: 'POST' });
    expect(res.status).toBe(405);
  });

  test('trace id header present', async () => {
    const res = await fetch(`${base}/api/ping`);
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  test('CORS headers when configured', async () => {
    const corsServer = await serveNode({
      services: [service],
      port: 0,
      cors: { origin: 'https://example.com', methods: 'GET, POST' },
    });
    const corsBase = `http://localhost:${corsServer.port}`;

    const res = await fetch(`${corsBase}/api/ping`, {
      headers: { origin: 'https://example.com' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://example.com');

    await corsServer.close();
  });
});
