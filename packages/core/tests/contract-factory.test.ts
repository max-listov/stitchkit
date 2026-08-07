/**
 * `createContractFactory` — a `defineContract` that requires a typed `scope`.
 * The type-level guarantee (scope required, from the app's union) is checked by
 * `tsc`; this covers the runtime shape and that the scope reaches the contract.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createClient, createScopedClients } from '../src/browser/client';
import { createContractFactory } from '../src/contract';
import { createServer, implement } from '../src/server';

const { defineContract } = createContractFactory<'public' | 'user' | 'admin'>();

const users = defineContract(
  { prefix: 'users', scope: 'user' },
  {
    list: { method: 'GET', path: '/', desc: 'List users', output: z.array(z.string()) },
  },
);

const admins = defineContract(
  { prefix: 'admins', scope: 'admin' },
  {
    list: { method: 'GET', path: '/', desc: 'List admins', output: z.array(z.string()) },
  },
);

const inferredUserScope: typeof users.meta.scope = 'user';
const inferredAdminScope: typeof admins.meta.scope = 'admin';
void inferredUserScope;
void inferredAdminScope;

function compileTimeFactoryChecks(): void {
  // @ts-expect-error the concrete contract retains the 'user' literal
  const wrongLiteral: typeof users.meta.scope = 'admin';
  void wrongLiteral;

  // @ts-expect-error scope remains required
  defineContract({ prefix: 'missing' }, {});

  // @ts-expect-error scope remains constrained to the factory vocabulary
  defineContract({ prefix: 'unknown', scope: 'owner' }, {});

  createScopedClients({ users, admins }, { baseUrl: '/api/' }, { user: {}, admin: {} });
}
void compileTimeFactoryChecks;

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
