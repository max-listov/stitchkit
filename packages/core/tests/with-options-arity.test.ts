/**
 * `withOptions` refuses an argument it would have to drop.
 *
 * The dropped argument is not a tidiness problem. `withOptions` is the only way
 * to pass an abort signal, its arity depends on whether the endpoint declares an
 * input, and the two shapes are one character apart at the call site. Passing
 * the two-argument shape to a no-input endpoint used to succeed: the options
 * were discarded, the request went out uncancelled, the caller still received
 * `REQUEST_ABORTED` — the cancellation wrapper reads the signal it was handed
 * whatever the transport did — and the server ran the operation to completion.
 *
 * Every symptom then points at the transport, which is where it was reported and
 * where two sessions looked. The measurements that cleared the transport are in
 * `unix-cancellation.test.ts`; this file is the part that makes the real mistake
 * say its own name.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createClient } from '../src/browser/client';
import { createHttpClient } from '../src/browser/http';
import { defineContract } from '../src/contract';

const contract = defineContract(
  { prefix: 'arity' },
  {
    ping: {
      method: 'GET',
      path: '/ping',
      desc: 'No input',
      output: z.object({ ok: z.boolean() }),
    },
    search: {
      method: 'GET',
      path: '/search',
      desc: 'Has input',
      input: z.object({ query: z.string() }),
      output: z.object({ ok: z.boolean() }),
    },
  },
);

const server = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true }) });
const baseUrl = `http://localhost:${server.port}`;

afterAll(() => void server.stop(true));

/**
 * The guard exists for call sites TypeScript never saw — generated wrappers,
 * dynamic dispatch, JavaScript — because a typed one is already refused at
 * compile time (proved by `bun run check` rejecting these very calls when they
 * were written normally). Reaching the runtime path from a typed test therefore
 * has to go through an untyped reference; the alternative is a test that cannot
 * call the shape it is about.
 */
function asUntypedCaller(
  api: unknown,
): Record<string, { withOptions: (...a: unknown[]) => unknown }> {
  return api as Record<string, { withOptions: (...a: unknown[]) => unknown }>;
}

describe.each([
  ['bare fetch', () => createClient(contract, { baseUrl })],
  ['Ky adapter', () => createClient(contract, createHttpClient({ baseUrl }))],
])('withOptions arity — %s', (_name, makeClient) => {
  test('a no-input endpoint refuses the two-argument shape', () => {
    const api = asUntypedCaller(makeClient());
    const controller = new AbortController();
    expect(() => api.ping?.withOptions({}, { signal: controller.signal })).toThrow(
      /declares no input.*withOptions\(options\).*received 2/s,
    );
  });

  test('an endpoint with input refuses a third argument', () => {
    const api = asUntypedCaller(makeClient());
    const controller = new AbortController();
    expect(() =>
      api.search?.withOptions({ query: 'q' }, { signal: controller.signal }, {}),
    ).toThrow(/declares an input.*withOptions\(args, options\).*received 3/s);
  });

  test('the correct shapes still work on both endpoints', async () => {
    const api = makeClient();
    await expect(api.ping.withOptions({})).resolves.toEqual({ ok: true });
    await expect(api.search.withOptions({ query: 'q' }, {})).resolves.toEqual({ ok: true });
  });

  test('the guard counts arguments without reading them', () => {
    // The rule this must not break: a client method survives being handed a
    // foreign callback context, which may be a throwing getter. Reading the
    // argument to decide whether to refuse it would trip exactly that.
    const api = asUntypedCaller(makeClient());
    const hostile = Object.defineProperty({}, 'signal', {
      get() {
        throw new Error('the guard read the argument it was counting');
      },
    });
    expect(() => api.ping?.withOptions({}, hostile)).toThrow(/received 2/);
  });
});
