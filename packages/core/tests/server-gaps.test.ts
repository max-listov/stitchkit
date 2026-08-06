import { afterAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { RuntimeContext } from '../src/contract';
import { defineContract } from '../src/contract';
import { createImplement, createServer, implement } from '../src/server';

// ─── Gap 1: GET query params ────────────────────────

describe('GET query params', () => {
  let PORT = 0;

  const ListInputSchema = z.object({
    status: z.string().optional(),
    page: z.coerce.number().optional(),
    limit: z.coerce.number().optional(),
  });

  const items = defineContract(
    { prefix: 'items' },
    {
      list: {
        method: 'GET',
        path: '/',
        desc: 'List items',
        input: ListInputSchema,
        output: z.object({
          status: z.string().optional(),
          page: z.number().optional(),
          limit: z.number().optional(),
        }),
      },
      search: {
        method: 'GET',
        path: '/search',
        desc: 'Search',
        input: z.object({ q: z.string() }),
        output: z.object({ query: z.string() }),
      },
    },
  );

  const service = implement(items, {
    list: (ctx) => ({
      status: ctx.input?.status,
      page: ctx.input?.page,
      limit: ctx.input?.limit,
    }),
    search: (ctx) => ({ query: ctx.input.q }),
  });

  let server: ReturnType<typeof createServer>;

  test('setup', () => {
    server = createServer({ services: [service], port: 0 });
    PORT = server.port ?? 0;
  });

  test('GET with query params parsed by inputSchema', async () => {
    const res = await fetch(`http://localhost:${PORT}/items?status=active&page=2&limit=10`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('active');
    expect(data.page).toBe(2);
    expect(data.limit).toBe(10);
  });

  test('GET without query params — optional fields undefined', async () => {
    const res = await fetch(`http://localhost:${PORT}/items`);
    expect(res.status).toBe(200);
  });

  test('GET /search?q=hello', async () => {
    const res = await fetch(`http://localhost:${PORT}/items/search?q=hello`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.query).toBe('hello');
  });

  test('GET /search without required param — validation error', async () => {
    const res = await fetch(`http://localhost:${PORT}/items/search`);
    expect(res.status).toBe(400);
  });

  afterAll(() => server?.stop());
});

// ─── Gap 2: Route groups ────────────────────────────

describe('route groups', () => {
  let PORT = 0;

  const broadcasts = defineContract(
    { prefix: 'broadcasts' },
    {
      list: {
        method: 'GET',
        path: '/',
        desc: 'List broadcasts',
        output: z.object({ botId: z.string() }),
      },
    },
  );

  const auth = defineContract(
    { prefix: 'auth', scope: 'public' },
    {
      ping: {
        method: 'GET',
        path: '/ping',
        desc: 'Ping',
        output: z.object({ ok: z.boolean() }),
      },
    },
  );

  const broadcastService = implement(broadcasts, {
    list: (ctx) => ({ botId: (ctx as Record<string, unknown>).botId as string }),
  });

  const authService = implement(auth, {
    ping: () => ({ ok: true }),
  });

  let server: ReturnType<typeof createServer>;

  test('setup with groups + flat services', () => {
    server = createServer({
      services: [authService],
      groups: [
        {
          pathPrefix: '/bots/:botId',
          services: [broadcastService],
        },
      ],
      port: 0,
    });
    PORT = server.port ?? 0;
  });

  test('grouped route: GET /bots/:botId/broadcasts', async () => {
    const res = await fetch(`http://localhost:${PORT}/bots/bot-123/broadcasts`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.botId).toBe('bot-123');
  });

  test('flat service still works: GET /auth/ping', async () => {
    const res = await fetch(`http://localhost:${PORT}/auth/ping`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  test('group prefix params in context', async () => {
    const res = await fetch(`http://localhost:${PORT}/bots/my-bot-id/broadcasts`);
    const data = await res.json();
    expect(data.botId).toBe('my-bot-id');
  });

  afterAll(() => server?.stop());
});

// ─── Gap 2b: Per-group hooks ────────────────────────

describe('per-group hooks', () => {
  let PORT = 0;

  const contract = defineContract(
    { prefix: 'data' },
    {
      get: {
        method: 'GET',
        path: '/',
        desc: 'Get data',
        output: z.object({ enriched: z.boolean() }),
      },
    },
  );

  const service = implement(contract, {
    get: (ctx) => ({ enriched: (ctx as Record<string, unknown>).enriched === true }),
  });

  let server: ReturnType<typeof createServer>;

  test('group hooks enrich context', async () => {
    server = createServer({
      groups: [
        {
          pathPrefix: '/scope/:scopeId',
          services: [service],
          hooks: {
            beforeHandle: (ctx) => {
              (ctx as Record<string, unknown>).enriched = true;
            },
          },
        },
      ],
      port: 0,
    });
    PORT = server.port ?? 0;

    const res = await fetch(`http://localhost:${PORT}/scope/abc/data`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.enriched).toBe(true);
  });

  afterAll(() => server?.stop());
});

// ─── Gap 4: createImplement factory ─────────────────

describe('createImplement factory', () => {
  interface BotContext extends RuntimeContext {
    botId: string;
    projectId: string;
  }

  const implementBot = createImplement<BotContext>();

  test('factory returns implement function', () => {
    const contract = defineContract(
      { prefix: 'test' },
      {
        get: { method: 'GET', path: '/', desc: 'Test', output: z.object({ ok: z.boolean() }) },
      },
    );

    const service = implementBot(contract, {
      get: (ctx) => {
        void ctx.botId;
        return { ok: true };
      },
    });

    expect(service.name).toBe('test');
    expect(service.methods.get).toBeDefined();
  });
});

// ─── Gap 5: Client GET query params ─────────────────

describe('client GET query params (fetch path)', () => {
  let PORT = 0;

  const contract = defineContract(
    { prefix: 'search' },
    {
      find: {
        method: 'GET',
        path: '/',
        desc: 'Search',
        input: z.object({ q: z.string(), page: z.coerce.number().optional() }),
        output: z.object({ q: z.string(), page: z.number().optional() }),
      },
    },
  );

  const service = implement(contract, {
    find: (ctx) => ({ q: ctx.input.q, page: ctx.input?.page }),
  });

  let server: ReturnType<typeof createServer>;

  test('setup', () => {
    server = createServer({ services: [service], port: 0 });
    PORT = server.port ?? 0;
  });

  test('createClient sends query params on GET', async () => {
    const { createClient } = await import('../src/browser/client');

    const api = createClient(contract, { baseUrl: `http://localhost:${PORT}` });
    const result = await api.find({ q: 'hello', page: 3 });

    expect(result?.q).toBe('hello');
    expect(result?.page).toBe(3);
  });

  afterAll(() => server?.stop());
});
