/**
 * A contract-wide `meta` default, shallow-merged under each endpoint's own.
 * → ADR 0036.
 *
 * Shallow merge rather than override because `meta` is not decoration: the
 * OpenAPI generator documents `meta: { public: true }` as the declarative
 * allowlist for the published spec, so an endpoint adding one key must not drop
 * the contract's. `expose` deliberately does NOT cascade — see the ADR.
 */

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createHttpClient } from '../src/browser/http';
import { createContractFactory, defineContract } from '../src/contract';
import { implement } from '../src/server';
import { implementRemote } from '../src/tools/remote';

const OUT = z.object({ ok: z.boolean() });

/** Build a contract with an optional contract-level `meta`, then implement it. */
function serviceWith(
  contractMeta: Record<string, unknown> | undefined,
  endpointMeta: Record<string, unknown> | undefined,
) {
  const contract = defineContract(
    { prefix: 'notes', ...(contractMeta && { meta: contractMeta }) },
    {
      get: {
        method: 'GET',
        path: '/',
        desc: 'Get a note',
        output: OUT,
        ...(endpointMeta && { meta: endpointMeta }),
      },
    },
  );
  return implement(contract, { get: () => ({ ok: true }) });
}

describe('contract-level meta cascade', () => {
  test('reaches an endpoint that declares none', () => {
    expect(serviceWith({ owner: 'auth' }, undefined).methods.get?.meta).toEqual({
      owner: 'auth',
    });
  });

  test('an endpoint key wins over the contract key, and the others survive', () => {
    // The second contract-only key is what makes this an assertion: without it,
    // "endpoint wins" is indistinguishable from ignoring the contract entirely.
    expect(serviceWith({ tier: 1, keep: 'x' }, { tier: 2 }).methods.get?.meta).toEqual({
      tier: 2,
      keep: 'x',
    });
  });

  test('the OpenAPI allowlist case — adding a key keeps the contract-wide one', () => {
    // Override would silently drop `public` and the endpoint would vanish from
    // the published spec with no diff explaining why.
    expect(serviceWith({ public: true }, { rateTier: 2 }).methods.get?.meta).toEqual({
      public: true,
      rateTier: 2,
    });
  });

  test('neither declared → meta stays undefined, not an empty object', () => {
    // Readers test `method.meta?.public`; `{}` would read as "declared".
    expect(serviceWith(undefined, undefined).methods.get?.meta).toBeUndefined();
  });

  test('only the endpoint declares → unchanged from 0.25.0', () => {
    expect(serviceWith(undefined, { owner: 'x' }).methods.get?.meta).toEqual({ owner: 'x' });
  });
});

describe('each MethodDef owns its meta — no aliasing', () => {
  test("mutating one endpoint's meta touches neither its sibling nor the contract", () => {
    const shared = { public: true };
    const contract = defineContract(
      { prefix: 'notes', meta: shared },
      {
        get: { method: 'GET', path: '/', desc: 'Get', output: OUT },
        list: { method: 'GET', path: '/all', desc: 'List', output: OUT },
      },
    );
    const service = implement(contract, {
      get: () => ({ ok: true }),
      list: () => ({ ok: true }),
    });
    const first = service.methods.get?.meta;
    if (!first) throw new Error('expected meta');
    first.leaked = 'X';

    expect(service.methods.list?.meta).toEqual({ public: true });
    expect(contract.meta.meta).toEqual({ public: true });
    expect(shared).toEqual({ public: true });
    // …and a later implement of the same contract is clean too.
    const second = implement(contract, {
      get: () => ({ ok: true }),
      list: () => ({ ok: true }),
    });
    expect(second.methods.get?.meta).toEqual({ public: true });
  });
});

describe('the cascade reaches every MethodDef producer', () => {
  test('implementRemote merges the same way', () => {
    const contract = defineContract(
      { prefix: 'notes', meta: { public: true } },
      { get: { method: 'GET', path: '/', desc: 'Get', output: OUT, meta: { tier: 2 } } },
    );
    const service = implementRemote(contract, createHttpClient({ baseUrl: 'http://x' }));
    expect(service.methods.get?.meta).toEqual({ public: true, tier: 2 });
  });

  test('a factory-built contract keeps its contract-level meta', () => {
    // The factory used to rebuild the meta object by hand, which silently
    // dropped every field but `prefix` and `scope`.
    const { defineContract: scoped } = createContractFactory<'public' | 'admin'>();
    const contract = scoped(
      { prefix: 'notes', scope: 'admin', meta: { owner: 'auth' } },
      { get: { method: 'GET', path: '/', desc: 'Get', output: OUT } },
    );
    expect(contract.meta.meta).toEqual({ owner: 'auth' });
    expect(implement(contract, { get: () => ({ ok: true }) }).methods.get?.meta).toEqual({
      owner: 'auth',
    });
  });
});

describe('expose deliberately does not cascade', () => {
  test('a contract-level expose is not a thing — endpoints keep 0.25.0 behaviour', () => {
    const service = serviceWith({ owner: 'x' }, undefined);
    // No `expose` anywhere → still a tool on MCP and AGENT, exactly as before.
    expect(service.methods.get?.expose).toBeUndefined();
  });
});
