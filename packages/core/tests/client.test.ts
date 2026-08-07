import { afterAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createClient } from '../src/browser/client';
import { createHttpClient } from '../src/browser/http';
import { defineContract } from '../src/contract';
import { createServer, implement } from '../src/server';

const UserSchema = z.object({ id: z.string(), name: z.string() });
const CreateSchema = z.object({ name: z.string() });
const IdSchema = z.object({ id: z.string() });

const users = defineContract(
  { prefix: 'users' },
  {
    list: { method: 'GET', path: '/', desc: 'List', output: z.array(UserSchema) },
    create: {
      method: 'POST',
      path: '/',
      desc: 'Create',
      input: CreateSchema,
      output: UserSchema,
    },
    get: { method: 'GET', path: '/:id', desc: 'Get', params: IdSchema, output: UserSchema },
  },
);

const WildcardClientParamsSchema = z.object({ slug: z.string(), '*': z.string() });
const WildcardClientOutputSchema = z.object({ slug: z.string(), remainder: z.string() });
const wildcardClientContract = defineContract(
  { prefix: 'wildcard-client' },
  {
    get: {
      method: 'GET',
      path: '/:slug/*',
      desc: 'Get a nested wildcard path',
      params: WildcardClientParamsSchema,
      output: WildcardClientOutputSchema,
    },
  },
);

const db = [{ id: '1', name: 'Alice' }];

const service = implement(users, {
  list: () => db,
  create: (ctx) => {
    const u = { id: '2', name: ctx.input.name };
    db.push(u);
    return u;
  },
  get: (ctx) => {
    const u = db.find((u) => u.id === ctx.params.id);
    if (!u) throw new Error('Not found');
    return u;
  },
});

const wildcardClientService = implement(wildcardClientContract, {
  get: ({ params }) => ({ slug: params.slug, remainder: params['*'] }),
});

let PORT = 0;
let server: ReturnType<typeof createServer>;

describe('createClient', () => {
  test('setup server', () => {
    server = createServer({ services: [service, wildcardClientService], port: 0 });
    PORT = server.port ?? 0;
  });

  test('list — no args', async () => {
    const api = createClient(users, { baseUrl: `http://localhost:${PORT}` });
    const result = await api.list();
    expect(Array.isArray(result)).toBe(true);
    expect(result[0]?.name).toBe('Alice');
  });

  test('create — with input', async () => {
    const api = createClient(users, { baseUrl: `http://localhost:${PORT}` });
    const result = await api.create({ name: 'Dave' });
    expect(result.name).toBe('Dave');
    expect(result.id).toBeDefined();
  });

  test('get — with path params', async () => {
    const api = createClient(users, { baseUrl: `http://localhost:${PORT}` });
    const result = await api.get({ id: '1' });
    expect(result.name).toBe('Alice');
  });

  test('bare-fetch client expands a terminal wildcard into path segments', async () => {
    const api = createClient(wildcardClientContract, {
      baseUrl: `http://localhost:${PORT}`,
    });
    const result = await api.get({ slug: 'foo', '*': 'folder one/leaf#two' });
    expect(result).toEqual({ slug: 'foo', remainder: 'folder one/leaf#two' });
  });

  test('HttpClient adapter expands and segment-encodes a terminal wildcard', async () => {
    const api = createClient(
      wildcardClientContract,
      createHttpClient({ baseUrl: `http://localhost:${PORT}` }),
    );
    const result = await api.get({ slug: 'foo', '*': 'folder one/leaf#two' });
    expect(result).toEqual({ slug: 'foo', remainder: 'folder one/leaf#two' });
  });

  test('client validates response with output schema', async () => {
    const api = createClient(users, { baseUrl: `http://localhost:${PORT}` });
    const result = await api.get({ id: '1' });
    expect(result).toHaveProperty('id');
    expect(result).toHaveProperty('name');
  });

  test('client throws on 500', async () => {
    const api = createClient(users, { baseUrl: `http://localhost:${PORT}` });
    await expect(api.get({ id: '999' })).rejects.toThrow();
  });

  test('custom headers', async () => {
    const api = createClient(users, {
      baseUrl: `http://localhost:${PORT}`,
      headers: { 'X-Custom': 'test' },
    });
    const result = await api.list();
    expect(Array.isArray(result)).toBe(true);
  });

  test('headers as function', async () => {
    let called = false;
    const api = createClient(users, {
      baseUrl: `http://localhost:${PORT}`,
      headers: () => {
        called = true;
        return { 'X-Dynamic': 'yes' };
      },
    });
    await api.list();
    expect(called).toBe(true);
  });

  afterAll(() => {
    server?.stop();
  });
});

// ─── GET / DELETE query input + client-side traceparent ──────────────────────

const SearchInput = z.object({
  q: z.string().optional(),
  tags: z.array(z.string()).optional(),
  filter: z.record(z.string(), z.string()).optional(),
});

const search = defineContract(
  { prefix: 'search' },
  {
    query: {
      method: 'GET',
      path: '/',
      desc: 'Search',
      input: SearchInput,
      output: z.object({ q: z.string().nullable(), tags: z.array(z.string()) }),
    },
    remove: {
      method: 'DELETE',
      path: '/',
      desc: 'Remove',
      input: SearchInput,
      output: z.object({ ok: z.boolean() }),
    },
  },
);

const traceEcho = defineContract(
  { prefix: 'trace-echo' },
  {
    get: {
      method: 'GET',
      path: '/',
      desc: 'Echo the traceparent header',
      output: z.object({ tp: z.string().nullable() }),
    },
  },
);

const searchService = implement(search, {
  query: (ctx) => ({ q: ctx.input.q ?? null, tags: ctx.input.tags ?? [] }),
  remove: () => ({ ok: true }),
});

const traceService = implement(traceEcho, {
  get: (ctx) => ({ tp: ctx.req?.headers.get('traceparent') ?? null }),
});

let queryBaseUrl = '';
let queryServer: ReturnType<typeof createServer>;

describe('GET / DELETE query input', () => {
  test('setup server', () => {
    queryServer = createServer({
      services: [searchService, traceService],
      port: 0,
    });
    queryBaseUrl = `http://localhost:${queryServer.port}`;
  });

  test('flat fields and primitive arrays travel as query params', async () => {
    const api = createClient(search, { baseUrl: queryBaseUrl });
    const result = await api.query({ q: 'durian', tags: ['fruit', 'tropical'] });
    expect(result).toEqual({ q: 'durian', tags: ['fruit', 'tropical'] });
  });

  test('a nested object in GET input throws loudly (bare fetch client)', async () => {
    const api = createClient(search, { baseUrl: queryBaseUrl });
    await expect(api.query({ filter: { name: 'x' } })).rejects.toThrow(
      /GET \/: input field "filter" is a nested object/,
    );
  });

  test('a nested object in GET input throws loudly (HttpClient adapter)', () => {
    const api = createClient(search, createHttpClient({ baseUrl: queryBaseUrl }));
    expect(() => api.query({ filter: { name: 'x' } })).toThrow(
      /cannot travel as a query parameter/,
    );
  });

  test('a nested object in DELETE input throws loudly', () => {
    const api = createClient(search, createHttpClient({ baseUrl: queryBaseUrl }));
    expect(() => api.remove({ filter: { name: 'x' } })).toThrow(
      /DELETE \/: input field "filter"/,
    );
  });

  afterAll(() => {
    queryServer?.stop();
  });
});

describe('createHttpClient trace', () => {
  const W3C_TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/;

  test('trace: true sends a valid W3C traceparent on every request', async () => {
    const api = createClient(
      traceEcho,
      createHttpClient({ baseUrl: queryBaseUrl, trace: true }),
    );
    const { tp } = await api.get();
    expect(tp).toMatch(W3C_TRACEPARENT);
  });

  test('each request gets a fresh root trace', async () => {
    const api = createClient(
      traceEcho,
      createHttpClient({ baseUrl: queryBaseUrl, trace: true }),
    );
    const first = await api.get();
    const second = await api.get();
    expect(first.tp).not.toBe(second.tp);
  });

  test('no traceparent without the option', async () => {
    const api = createClient(traceEcho, createHttpClient({ baseUrl: queryBaseUrl }));
    const { tp } = await api.get();
    expect(tp).toBeNull();
  });

  test('a caller-set traceparent header wins over the generated one', async () => {
    const manual = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;
    const api = createClient(
      traceEcho,
      createHttpClient({
        baseUrl: queryBaseUrl,
        trace: true,
        headers: { traceparent: manual },
      }),
    );
    const { tp } = await api.get();
    expect(tp).toBe(manual);
  });
});
