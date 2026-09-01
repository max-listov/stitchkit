import { afterAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { createServer, implement } from '../src/server';

const UserSchema = z.object({ id: z.string(), name: z.string() });
const CreateUserSchema = z.object({ name: z.string() });
const IdParamsSchema = z.object({ id: z.string() });

const users = defineContract(
  { prefix: 'users' },
  {
    list: { method: 'GET', path: '/', desc: 'List users', output: z.array(UserSchema) },
    create: {
      method: 'POST',
      path: '/',
      desc: 'Create user',
      input: CreateUserSchema,
      output: UserSchema,
    },
    get: {
      method: 'GET',
      path: '/:id',
      desc: 'Get user',
      params: IdParamsSchema,
      output: UserSchema,
    },
    delete: { method: 'DELETE', path: '/:id', desc: 'Delete user', params: IdParamsSchema },
  },
);

const db = [
  { id: '1', name: 'Alice' },
  { id: '2', name: 'Bob' },
];

const usersService = implement(users, {
  list: () => db,
  create: (ctx) => {
    const user = { id: String(db.length + 1), name: ctx.input.name };
    db.push(user);
    return user;
  },
  get: (ctx) => {
    const user = db.find((u) => u.id === ctx.params.id);
    if (!user) throw new Error('Not found');
    return user;
  },
  delete: (ctx) => {
    const idx = db.findIndex((u) => u.id === ctx.params.id);
    if (idx !== -1) db.splice(idx, 1);
  },
});

let PORT = 0;
let server: ReturnType<typeof createServer>;

describe('createServer + implement', () => {
  test('starts server', () => {
    server = createServer({
      services: [usersService],
      port: 0,
      cors: { origin: '*' },
    });
    PORT = server.port ?? 0;
    // The kernel assigned it — a fixed number would be a scheduled flake.
    expect(PORT).toBeGreaterThan(0);
  });

  test('GET /users — list', async () => {
    const res = await fetch(`http://localhost:${PORT}/users`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(2);
  });

  test('POST /users — create with valid input', async () => {
    const res = await fetch(`http://localhost:${PORT}/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Charlie' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe('Charlie');
    expect(data.id).toBeDefined();
  });

  test('POST /users — validation error on invalid input', async () => {
    const res = await fetch(`http://localhost:${PORT}/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wrong: 'field' }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe('VALIDATION_ERROR');
  });

  test('GET /users/:id — path params', async () => {
    const res = await fetch(`http://localhost:${PORT}/users/1`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe('Alice');
  });

  test('GET /users/:id — not found', async () => {
    const res = await fetch(`http://localhost:${PORT}/users/999`);
    expect(res.status).toBe(500);
  });

  test('DELETE /users/:id — returns 204', async () => {
    const lenBefore = db.length;
    const res = await fetch(`http://localhost:${PORT}/users/1`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(db.length).toBe(lenBefore - 1);
  });

  test('GET /unknown — returns 404', async () => {
    const res = await fetch(`http://localhost:${PORT}/unknown`);
    expect(res.status).toBe(404);
  });

  test('OPTIONS — CORS preflight', async () => {
    const res = await fetch(`http://localhost:${PORT}/users`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://example.com' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  afterAll(() => {
    return server?.shutdown({ gracePeriodMs: 0 });
  });
});

describe('lifecycle hooks', () => {
  let hookServer: ReturnType<typeof createServer>;
  let HOOK_PORT = 0;
  const logs: string[] = [];

  const PongSchema = z.object({ pong: z.boolean() });

  test('hooks fire in order', async () => {
    const contract = defineContract(
      { prefix: 'test' },
      {
        ping: { method: 'GET', path: '/', desc: 'Ping', output: PongSchema },
      },
    );

    const service = implement(contract, {
      ping: () => ({ pong: true }),
    });

    hookServer = createServer({
      services: [service],
      port: 0,
      hooks: {
        onRequest: () => {
          logs.push('onRequest');
        },
        beforeHandle: () => {
          logs.push('beforeHandle');
        },
        afterHandle: (_ctx, result) => {
          logs.push('afterHandle');
          return result;
        },
        onError: () => {
          logs.push('onError');
        },
      },
    });
    HOOK_PORT = hookServer.port ?? 0;

    const res = await fetch(`http://localhost:${HOOK_PORT}/test`);
    expect(res.status).toBe(200);
    expect(logs).toEqual(['onRequest', 'beforeHandle', 'afterHandle']);
  });

  test('onRequest can return early Response', async () => {
    await hookServer?.shutdown({ gracePeriodMs: 0 });
    let BLOCK_PORT = 0;

    const contract = defineContract(
      { prefix: 'blocked' },
      {
        get: { method: 'GET', path: '/', desc: 'Blocked' },
      },
    );

    const service = implement(contract, {
      get: () => undefined,
    });

    hookServer = createServer({
      services: [service],
      port: 0,
      hooks: {
        onRequest: () => new Response('Blocked', { status: 403 }),
      },
    });
    BLOCK_PORT = hookServer.port ?? 0;

    const res = await fetch(`http://localhost:${BLOCK_PORT}/blocked`);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('Blocked');
  });

  afterAll(() => {
    return hookServer?.shutdown({ gracePeriodMs: 0 });
  });
});
