import { afterEach, expect, test } from 'bun:test';
import { z } from 'zod';
import { createClient } from '../src/browser/client';
import { ApiError, createHttpClient } from '../src/browser/http';
import { createRetryAwareFetch } from '../src/browser/http-fetch';
import { resolveClientFetch } from '../src/browser/native-fetch';
import { defineContract } from '../src/contract/define';

const nativeFetch = globalThis.fetch;
const bunRuntime = Reflect.get(globalThis, 'Bun');
afterEach(() => {
  globalThis.fetch = nativeFetch;
  Reflect.set(globalThis, 'Bun', bunRuntime);
});

test.each(['copied properties', 'spoofed own toString', 'native-looking proxy'])(
  '%s global fetch retains the first Request and exact init',
  async (kind) => {
    const seen: Array<{ input: unknown; init: unknown }> = [];
    const spy = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        seen.push({ input, init });
        return Response.json({ ok: true });
      },
      { preconnect: nativeFetch.preconnect },
    );
    if (kind === 'spoofed own toString') {
      Object.defineProperty(spy, 'toString', {
        value: () => Function.prototype.toString.call(nativeFetch),
      });
    }
    globalThis.fetch =
      kind === 'native-looking proxy'
        ? new Proxy(nativeFetch, {
            apply(_target, _receiver, args) {
              const [input, init] = args;
              seen.push({ input, init });
              return Promise.resolve(Response.json({ ok: true }));
            },
          })
        : spy;
    const request = new Request('http://identity.invalid/path', {
      signal: new AbortController().signal,
    });
    const init: RequestInit = { headers: { 'x-control': 'yes' } };
    const fetchAttempt = createRetryAwareFetch(resolveClientFetch());
    await fetchAttempt(request, init);
    expect(seen).toEqual([{ input: request, init }]);
    expect(seen[0]?.input).toBe(request);
    expect(seen[0]?.init).toBe(init);
    expect('signal' in init).toBe(false);
    expect('timeout' in init).toBe(false);
  },
);

test('explicit fetch and non-Bun defaults retain Request/init identity', async () => {
  const seen: Array<{ input: unknown; init: unknown }> = [];
  const explicit = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      seen.push({ input, init });
      return Response.json({ ok: true });
    },
    { preconnect: nativeFetch.preconnect },
  );
  expect(resolveClientFetch(explicit)).toBe(explicit);
  expect(resolveClientFetch(nativeFetch)).toBe(nativeFetch);
  const request = new Request('http://identity.invalid/path');
  const init: RequestInit = { signal: new AbortController().signal };
  await resolveClientFetch(explicit)(request, init);
  for (const runtime of [undefined, null]) {
    Reflect.set(globalThis, 'Bun', runtime);
    globalThis.fetch = explicit;
    await resolveClientFetch()(request, init);
  }
  expect(seen).toHaveLength(3);
  for (const observed of seen) {
    expect(observed.input).toBe(request);
    expect(observed.init).toBe(init);
  }
  expect('timeout' in init).toBe(false);
});

test('patched fetch retries keep explicit signal, body and unix materialization', async () => {
  const seen: Array<{ input: unknown; init: unknown; body?: string }> = [];
  const patched = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const observed: { input: unknown; init: unknown; body?: string } = { input, init };
      if (typeof input === 'string') observed.body = await new Request(input, init).text();
      seen.push(observed);
      return Response.json({ ok: true });
    },
    { preconnect: nativeFetch.preconnect },
  );
  globalThis.fetch = patched;
  const request = new Request('http://identity.invalid/path', {
    method: 'POST',
    body: 'retry-original-body',
    signal: new AbortController().signal,
  });
  const retry = createRetryAwareFetch(resolveClientFetch());
  await retry(request);
  await retry(request);
  expect(seen[0]?.input).toBe(request);
  expect(seen[0]?.init).toBeUndefined();
  expect(seen[1]?.input).toBe(request.url);
  expect(seen[1]?.init).toMatchObject({ signal: request.signal, duplex: 'half' });
  expect(seen[1]?.body).toBe('retry-original-body');
  const socketRequest = new Request(request.url, { method: 'GET' });
  await createRetryAwareFetch(resolveClientFetch(), '/tmp/control-unused.sock')(socketRequest);
  expect(seen[2]?.input).toBe(socketRequest.url);
  expect(seen[2]?.init).toMatchObject({ unix: '/tmp/control-unused.sock' });
});

const output = z.object({ value: z.number() });
const contract = defineContract(
  { prefix: '' },
  {
    mutate: { method: 'POST', path: '/mutation', output, desc: 'Idle control' },
  },
);

test.each(['configured', 'bare'])(
  '%s native requests retain whole deadline and caller abort through body reads',
  async (lane) => {
    let calls = 0;
    let partialBody = false;
    let started = (): void => undefined;
    let originStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch() {
        calls += 1;
        started();
        if (partialBody) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"value":'));
                timer = setTimeout(() => {
                  controller.enqueue(new TextEncoder().encode('1}'));
                  controller.close();
                }, 150);
              },
              cancel() {
                clearTimeout(timer);
              },
            }),
          );
        }
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(Response.json({ value: 1 })), 150);
        });
      },
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const client = createClient(
      contract,
      lane === 'configured'
        ? createHttpClient({ baseUrl, timeout: 25, retry: { limit: 2 } })
        : { baseUrl, timeout: 25 },
    );
    try {
      for (const body of [false, true]) {
        partialBody = body;
        const before = calls;
        await expect(client.mutate()).rejects.toMatchObject({
          code: 'REQUEST_TIMEOUT',
          status: 0,
        });
        expect(calls).toBe(before + 1);
        originStarted = new Promise<void>((resolve) => {
          started = resolve;
        });
        const controller = new AbortController();
        const longer = createClient(
          contract,
          lane === 'configured'
            ? createHttpClient({ baseUrl, timeout: 1000, retry: { limit: 2 } })
            : { baseUrl, timeout: 1000 },
        );
        const pending = longer.mutate.withOptions({ signal: controller.signal });
        void pending.catch(() => undefined);
        await originStarted;
        controller.abort(new Error('synthetic caller reason'));
        await expect(pending).rejects.toMatchObject({ code: 'REQUEST_ABORTED', status: 0 });
        expect(calls).toBe(before + 2);
      }
      const controller = new AbortController();
      controller.abort();
      const before = calls;
      let refused: unknown;
      try {
        await client.mutate.withOptions({ signal: controller.signal });
      } catch (error) {
        refused = error;
      }
      expect(ApiError.is(refused)).toBe(true);
      expect(refused).toMatchObject({ code: 'REQUEST_ABORTED' });
      expect(calls).toBe(before);
    } finally {
      await server.stop(true);
    }
  },
);
