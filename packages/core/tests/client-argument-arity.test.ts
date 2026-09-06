import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createClient } from '../src/browser/client';
import { defineContract } from '../src/contract/define';

/**
 * The call shape the types prescribe is the call shape that runs.
 *
 * This file is checked twice, and that is the point: `bun run check` decides
 * whether each call below is *typed*, and `bun test` decides whether it *works*.
 * Written with no cast anywhere, it cannot pass while the two disagree — a call
 * the types refuse fails the typecheck, and a typed call the runtime refuses
 * fails the test.
 *
 * It exists because an empty schema was reported as a place where they part
 * ways: `params: z.strictObject({})` was said to type as argument-free while
 * the runtime still demanded an arguments object, so `withOptions({ signal })`
 * threw `Client request options must be an object` before reaching `fetch`.
 * The runtime half is real; the type half is not. `keyof` of an empty Zod
 * object's input type is `string`, not `never` — Zod 4 gives it an index
 * signature — so `EndpointFn` takes the *arguments* branch, exactly as the
 * runtime does, and the argument-free call the report ran was never a typed
 * call. The forms below are the ones the contract actually offers, and they are
 * pinned here so neither side is "fixed" toward a disagreement later.
 */
const contract = defineContract(
  { prefix: 'demo' },
  {
    nothing: { method: 'GET', path: '/nothing', desc: 'no schema at all', output: z.string() },
    emptyParams: {
      method: 'GET',
      path: '/empty-params',
      desc: 'a params schema with no property',
      params: z.strictObject({}),
      output: z.string(),
    },
    emptyInput: {
      method: 'POST',
      path: '/empty-input',
      desc: 'a body schema with no property',
      input: z.strictObject({}),
      output: z.string(),
    },
    withParams: {
      method: 'GET',
      path: '/with-params',
      desc: 'ordinary params',
      params: z.object({ q: z.string() }),
      output: z.string(),
    },
    fromPath: {
      method: 'GET',
      path: '/from-path/:id',
      desc: 'params inferred from the literal, no schema',
      output: z.string(),
    },
  },
);

/** A client plus the requests it sent, so a call's effect is inspectable. */
function client() {
  const sent: Array<{ url: string; signal?: AbortSignal | null }> = [];
  const api = createClient(contract, {
    baseUrl: 'http://example.test',
    fetch: async (input, init) => {
      sent.push({ url: String(input), signal: init?.signal });
      return Response.json('ok');
    },
  });
  return { api, sent };
}

describe('only an endpoint with no schema at all is argument-free', () => {
  test('no schema: both call shapes take no arguments', async () => {
    const { api } = client();
    expect(await api.nothing()).toBe('ok');
    expect(await api.nothing.withOptions({ signal: AbortSignal.timeout(1000) })).toBe('ok');
  });

  test('an empty params schema takes the arguments form, and an empty object satisfies it', async () => {
    const { api } = client();
    expect(await api.emptyParams({})).toBe('ok');
    expect(await api.emptyParams.withOptions({}, { signal: AbortSignal.timeout(1000) })).toBe(
      'ok',
    );
  });

  test('an empty body schema behaves the same way', async () => {
    const { api } = client();
    expect(await api.emptyInput({})).toBe('ok');
    expect(await api.emptyInput.withOptions({}, { signal: AbortSignal.timeout(1000) })).toBe(
      'ok',
    );
  });
});

describe('declared arguments still reach the request', () => {
  test('ordinary params reach the query string', async () => {
    const { api, sent } = client();
    expect(await api.withParams({ q: 'x' })).toBe('ok');
    expect(sent[0]?.url).toContain('q=x');
  });

  test('params inferred from the path literal reach the path', async () => {
    const { api, sent } = client();
    expect(await api.fromPath({ id: '42' })).toBe('ok');
    expect(sent[0]?.url).toContain('/from-path/42');
  });
});

describe('the options argument keeps its guarantees', () => {
  test('the signal is delivered on both call shapes', async () => {
    const { api, sent } = client();
    await api.nothing.withOptions({ signal: AbortSignal.timeout(1000) });
    expect(sent[0]?.signal).toBeInstanceOf(AbortSignal);
    await api.withParams.withOptions({ q: 'x' }, { signal: AbortSignal.timeout(1000) });
    expect(sent[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  test('an extra argument is refused on both call shapes', () => {
    const { api } = client();
    const argumentFree = api.nothing.withOptions as (...args: unknown[]) => Promise<unknown>;
    expect(() => argumentFree({ signal: AbortSignal.timeout(1000) }, {})).toThrow(
      /withOptions/,
    );
    const withArguments = api.withParams.withOptions as (
      ...args: unknown[]
    ) => Promise<unknown>;
    expect(() => withArguments({ q: 'x' }, { signal: AbortSignal.timeout(1000) }, {})).toThrow(
      /withOptions/,
    );
  });

  test('options that are not an object are refused', () => {
    const { api } = client();
    const untyped = api.emptyParams.withOptions as (...args: unknown[]) => Promise<unknown>;
    expect(() => untyped({}, 'nope')).toThrow('Client request options must be an object');
  });
});
