import { afterAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createClient } from '../src/browser/client';
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

const PORT = 9878;
let server: ReturnType<typeof createServer>;

describe('createClient', () => {
  test('setup server', () => {
    server = createServer({ services: [service], port: PORT });
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
