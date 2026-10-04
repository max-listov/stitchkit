import { expect, test } from 'bun:test';
import { z } from 'zod';
import { createCliInvoker } from '../src/entrypoints/cli';
import { defineContract } from '../src/entrypoints/contract';
import { createHttpClient } from '../src/entrypoints/index';
import { implementRemote } from '../src/entrypoints/remote';

const contract = defineContract(
  { prefix: 'cancel' },
  {
    plain: {
      method: 'GET',
      path: '/plain',
      desc: 'No argument call',
      expose: ['HTTP', 'CLI'],
      tool: { name: 'plain' },
      output: z.object({ ok: z.boolean() }),
    },
    input: {
      method: 'POST',
      path: '/input',
      desc: 'Argument call',
      expose: ['HTTP', 'CLI'],
      tool: { name: 'input' },
      input: z.object({ text: z.string() }),
      output: z.object({ ok: z.boolean() }),
    },
    empty: {
      method: 'GET',
      path: '/empty',
      desc: 'Empty schema call',
      expose: ['HTTP', 'CLI'],
      tool: { name: 'empty' },
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
    },
  },
);

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('remote caller cancellation reaches both typed endpoint argument shapes', async () => {
  for (const [command, args] of [
    ['plain', {}],
    ['input', { text: 'value' }],
    ['empty', {}],
  ] as const) {
    const entered = deferred();
    let aborted = false;
    const transport: typeof globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        entered.resolve();
        await new Promise<void>((_resolve, reject) =>
          request.signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(request.signal.reason);
            },
            { once: true },
          ),
        );
        return Response.json({ ok: true });
      },
      { preconnect: globalThis.fetch.preconnect },
    );
    const controller = new AbortController();
    const service = implementRemote(
      contract,
      createHttpClient({ baseUrl: 'http://localhost', fetch: transport, retry: { limit: 0 } }),
    );
    const invoker = await createCliInvoker({
      name: 'cancel',
      services: [service],
      signal: controller.signal,
    });
    const pending = invoker.invoke(command, args);
    await entered.promise;
    controller.abort(new Error('private-caller-reason'));
    const result = await pending;
    expect(result).toMatchObject({
      ok: false,
      exitCode: 130,
      error: { code: 'REQUEST_ABORTED', retryable: false },
    });
    expect(aborted).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private-caller-reason');
  }
});

test('remote pre-abort and abort during argument transform prevent HTTP dispatch', async () => {
  let dispatched = 0;
  let transformed = 0;
  const transport: typeof globalThis.fetch = Object.assign(
    async () => {
      dispatched++;
      return Response.json({ ok: true });
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  const http = createHttpClient({ baseUrl: 'http://localhost', fetch: transport });
  const before = new AbortController();
  before.abort(new Error('private-before'));
  const first = await createCliInvoker({
    name: 'cancel',
    signal: before.signal,
    services: [
      implementRemote(contract, http, {
        transformArgs: (_key, args) => {
          transformed++;
          return args;
        },
      }),
    ],
  });
  expect(await first.invoke('input', { text: 'value' })).toMatchObject({
    ok: false,
    error: { code: 'REQUEST_ABORTED', retryable: false },
  });
  expect(transformed).toBe(0);
  const entered = deferred();
  const finish = deferred();
  const during = new AbortController();
  const second = await createCliInvoker({
    name: 'cancel',
    signal: during.signal,
    services: [
      implementRemote(contract, http, {
        transformArgs: async (_key, args) => {
          entered.resolve();
          await finish.promise;
          return args;
        },
      }),
    ],
  });
  const pending = second.invoke('input', { text: 'value' });
  await entered.promise;
  during.abort();
  finish.resolve();
  expect(await pending).toMatchObject({
    ok: false,
    error: { code: 'REQUEST_ABORTED', retryable: false },
  });
  expect(dispatched).toBe(0);
});

test('uncancelled remote calls keep typed argument and transform behavior', async () => {
  const observed: unknown[] = [];
  const transport: typeof globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      observed.push(await request.json());
      return Response.json({ ok: true });
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  const service = implementRemote(
    contract,
    createHttpClient({ baseUrl: 'http://localhost', fetch: transport }),
    {
      transformArgs: (_key, args) => ({ ...args, text: 'transformed' }),
    },
  );
  const invoker = await createCliInvoker({ name: 'normal', services: [service] });
  expect(await invoker.invoke('input', { text: 'original' })).toMatchObject({
    ok: true,
    data: { ok: true },
  });
  expect(observed).toEqual([{ text: 'transformed' }]);
});
