/**
 * `createContractFactory` — a `defineContract` that requires a typed `scope`.
 * The type-level guarantee (scope required, from the app's union) is checked by
 * `tsc`; this covers the runtime shape and that the scope reaches the contract.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createClient } from '../src/browser/client';
import { createContractFactory } from '../src/contract';
import { createServer, implement } from '../src/server';

const { defineContract } = createContractFactory<'public' | 'user' | 'admin'>();

const users = defineContract(
  { prefix: 'users', scope: 'user' },
  {
    list: { method: 'GET', path: '/', desc: 'List users', output: z.array(z.string()) },
  },
);

describe('createContractFactory', () => {
  test('the scope reaches the contract meta', () => {
    expect(users.meta).toEqual({ prefix: 'users', scope: 'user' });
  });

  test('the returned contract is an ordinary one — implement + serve + client', async () => {
    const service = implement(users, { list: () => ['alice', 'bob'] });
    const server = createServer({ services: [service], port: 0 });
    const api = createClient(users, { baseUrl: `http://localhost:${server.port}` });
    expect(await api.list()).toEqual(['alice', 'bob']);
    server.stop();
  });

  test('validation still fires (empty desc throws)', () => {
    expect(() =>
      defineContract(
        { prefix: 'bad', scope: 'public' },
        { x: { method: 'GET', path: '/', desc: '', output: z.string() } },
      ),
    ).toThrow(/empty desc/);
  });
});
