/**
 * Parity between the two client transports and the CORS exit path — the
 * divergences the 2026-07-09 audit found:
 *   1. an `onRequest` early Response must carry CORS like every other exit;
 *   2. the `HttpClient` (ky) client path must validate `output` — it used to
 *      return the body unvalidated, while the bare-fetch path validated;
 *   3. an unreachable host must read the same through both. The ky path filed
 *      the transport's text under `details.message` and passed `undefined` for
 *      the message and the cause, so the documented transport answered `API
 *      Error: UNKNOWN_ERROR` where the undocumented one answered "Unable to
 *      connect" — same failure, same client, two stories. Found 2026-09-02 from
 *      a consumer report that a bare code with no text reads as a refusal of
 *      permission.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createClient } from '../src/browser/client';
import { ApiError, createHttpClient } from '../src/browser/http';
import { defineContract } from '../src/contract';
import { createHandler, createServer, implement } from '../src/server';

describe('onRequest early response carries CORS', () => {
  const ping = defineContract(
    { prefix: 'ping' },
    { get: { method: 'GET', path: '/', desc: 'Ping', output: z.object({ ok: z.boolean() }) } },
  );
  const service = implement(ping, { get: () => ({ ok: true }) });

  test('a short-circuit Response gets Access-Control-Allow-Origin', async () => {
    const handler = createHandler({
      services: [service],
      cors: { origin: '*' },
      hooks: { onRequest: () => new Response('maintenance', { status: 503 }) },
    });
    const res = await handler(
      new Request('http://x/ping', { headers: { Origin: 'http://app.example' } }),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});

describe('HttpClient path validates output', () => {
  let baseUrl = '';

  // The server answers with only `{ id }` …
  const serverContract = defineContract(
    { prefix: 'widgets' },
    { get: { method: 'GET', path: '/', desc: 'Get', output: z.object({ id: z.string() }) } },
  );
  const service = implement(serverContract, { get: () => ({ id: '1' }) });
  let server: ReturnType<typeof createServer>;

  // … the client expects `{ id, name }` — a name the server never sends.
  const strictContract = defineContract(
    { prefix: 'widgets' },
    {
      get: {
        method: 'GET',
        path: '/',
        desc: 'Get',
        output: z.object({ id: z.string(), name: z.string() }),
      },
    },
  );

  test('setup', () => {
    server = createServer({ services: [service], port: 0 });
    baseUrl = `http://localhost:${server.port}`;
  });

  test('the ky adapter path rejects a response that fails the output schema', async () => {
    const api = createClient(strictContract, createHttpClient({ baseUrl }));
    await expect(api.get()).rejects.toThrow();
  });

  test('a conforming response still resolves', async () => {
    const api = createClient(serverContract, createHttpClient({ baseUrl }));
    expect(await api.get()).toEqual({ id: '1' });
  });

  afterAll(() => server?.shutdown({ gracePeriodMs: 0 }));
});

const unreachable = defineContract(
  { prefix: 'unreachable' },
  {
    ping: {
      method: 'GET',
      path: '/ping',
      desc: 'Ping',
      output: z.object({ ok: z.boolean() }),
    },
  },
);

/** The rejection of a call, insisted upon: a call that resolves has no failure to compare. */
async function failureOf(call: () => Promise<unknown>): Promise<ApiError> {
  const settled = await call().then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!ApiError.is(settled)) throw new Error(`expected an ApiError, got ${String(settled)}`);
  return settled;
}

describe('both transports tell the same story about one failure', () => {
  // Nothing listens on port 1, so the transport fails before any response
  // exists — the branch where the two paths built their `ApiError` differently.
  const baseUrl = 'http://127.0.0.1:1';

  test('an unreachable host reads the same through the ky adapter and bare fetch', async () => {
    const viaKy = await failureOf(() =>
      createClient(
        unreachable,
        createHttpClient({ baseUrl, retry: { limit: 0 }, timeout: 2_000 }),
      ).ping(),
    );
    const viaFetch = await failureOf(() =>
      createClient(unreachable, { baseUrl, timeout: 2_000 }).ping(),
    );

    // Agreement, not a literal: the wording belongs to the runtime and may
    // change with it, and a test pinned to the string would redden on a Bun
    // upgrade while the divergence it exists to catch passed unnoticed.
    expect(viaKy.code).toBe(viaFetch.code);
    expect(viaKy.message).toBe(viaFetch.message);
    // Presence before comparison: `undefined` on both sides would satisfy an
    // equality check while explaining nothing, and reading `.message` off it
    // would throw — which reads as a broken test, not as a failure.
    expect(viaKy.cause).toBeInstanceOf(Error);
    expect(viaFetch.cause).toBeInstanceOf(Error);
    expect((viaKy.cause as Error).message).toBe((viaFetch.cause as Error).message);

    // The half that actually regressed. Equality alone would also hold if both
    // paths fell back to the code, so name what the ky path owed: the real text
    // in `message`, and the same text `details` already carried.
    expect(viaKy.message).not.toBe(`${viaKy.code} (no message supplied)`);
    expect(viaKy.message).toBe((viaKy.details as { message: string }).message);
  });

  test('an injected adapter error survives as `cause` on both paths', async () => {
    // `docs/guide/client.md` builds a safety procedure on this: never replay an
    // effect from `UNKNOWN_ERROR` alone, inspect the adapter's `cause` and retry
    // only when it proves dispatch did not happen. The ky path dropped `cause`,
    // so on the documented transport that procedure could never reach its own
    // conclusion — the guide described a client only the other path was.
    class AdapterFailure extends Error {
      constructor(readonly dispatch: 'not-dispatched' | 'possibly-dispatched') {
        super(`adapter refused: ${dispatch}`);
      }
    }
    const injected = () => Promise.reject(new AdapterFailure('not-dispatched'));

    for (const client of [
      createClient(
        unreachable,
        createHttpClient({ baseUrl: 'http://x', retry: { limit: 0 }, fetch: injected }),
      ),
      createClient(unreachable, { baseUrl: 'http://x', fetch: injected }),
    ]) {
      const error = await failureOf(() => client.ping());
      expect(error.code).toBe('UNKNOWN_ERROR');
      // The adapter's own object, not a copy of its text: the decision the guide
      // describes reads a field, and a re-wrapped Error would not carry it.
      expect(error.cause).toBeInstanceOf(AdapterFailure);
      expect((error.cause as AdapterFailure).dispatch).toBe('not-dispatched');
    }
  });
});

describe('an ApiError admits when nothing explained it', () => {
  async function errorFor(body: unknown): Promise<ApiError> {
    const origin = Bun.serve({ port: 0, fetch: () => Response.json(body, { status: 400 }) });
    try {
      const api = createClient(
        unreachable,
        createHttpClient({ baseUrl: origin.url.origin, retry: { limit: 0 } }),
      );
      return await failureOf(() => api.ping());
    } finally {
      origin.stop(true);
    }
  }

  test('a code answered without a message admits it instead of restating the code', async () => {
    // `API Error: INVALID_INPUT` read like an explanation and was not one, so a
    // caller could not tell an origin that explained itself from one that said
    // nothing. Those are different answers.
    const error = await errorFor({ error: { code: 'INVALID_INPUT' } });
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe('INVALID_INPUT (no message supplied)');
  });

  test('an empty message is no message', async () => {
    // `??` only catches `null` and `undefined`, so `''` used to reach the caller
    // as an explanation of zero length.
    const error = await errorFor({ error: { code: 'INVALID_INPUT', message: '' } });
    expect(error.message).toBe('INVALID_INPUT (no message supplied)');
  });

  test('a supplied message is carried through untouched', async () => {
    // The negative control, and the reason the two tests above mean anything: a
    // fallback that fired unconditionally would satisfy both of them while
    // destroying every real explanation the origin sent.
    const error = await errorFor({
      error: { code: 'INVALID_INPUT', message: 'age must be a number' },
    });
    expect(error.message).toBe('age must be a number');
  });
});
