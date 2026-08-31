import { expect, test } from 'bun:test';
import { z } from 'zod';
import {
  createApplication,
  defineManagedResource,
  managedServerResource,
} from '../src/application';
import { defineContract } from '../src/contract';
import { createServer, implement, streamingRoute } from '../src/server';

const Item = z.object({ ready: z.boolean() });
function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}
async function open(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { signal });
  expect(response.status).toBe(200);
  if (!response.body) throw new Error('Expected streaming body');
  const reader = response.body.getReader();
  let text = '';
  while (!text.includes('ready')) {
    const next = await reader.read();
    expect(next.done).toBe(false);
    text += new TextDecoder().decode(next.value);
  }
  return reader;
}

for (const format of ['ndjson', 'sse'] satisfies Array<'ndjson' | 'sse'>) {
  test(`managed ${format} streams finish their source before dependencies close`, async () => {
    let returned = 0;
    let aborted = 0;
    const contract = defineContract(
      { prefix: 'probe' },
      {
        events: { method: 'GET', path: '/', desc: 'Observe', stream: { item: Item, format } },
      },
    );
    const service = implement(contract, {
      events: async function* ({ signal }) {
        if (!signal) throw new Error('Expected operation signal');
        try {
          yield { ready: true };
          await untilAborted(signal);
          aborted += 1;
        } finally {
          await Bun.sleep(15);
          returned += 1;
        }
      },
    });
    const server = createServer({ port: 0, services: [service], logging: false });
    const dependency = defineManagedResource({
      id: 'source',
      start: () => undefined,
      close() {
        expect(returned).toBe(2);
      },
    });
    const app = createApplication({
      id: 'probe',
      resources: [
        dependency,
        managedServerResource({ id: 'http', server, dependsOn: [dependency] }),
      ],
      shutdown: { gracePeriodMs: 500, forceTimeoutMs: 200 },
    });
    await app.start();
    const readers = await Promise.all([
      open(`${server.url}/probe`),
      open(`${server.url}/probe`),
    ]);
    expect(server.status.completedRequests).toBe(0);
    const result = await app.shutdown();
    expect(result.cleanupComplete).toBe(true);
    expect(result.outcome).toBe('clean');
    expect(aborted).toBe(2);
    expect(returned).toBe(2);
    expect(server.status.pendingRequests).toBe(0);
    expect(server.status.completedRequests).toBe(2);
    for (const reader of readers) await reader.cancel();
  });
}

test('raw stream cancellation retains a waiting finally in managed pending counts', async () => {
  const cleanup = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const route = streamingRoute({
    path: '/probe',
    source: async function* (_request, { signal }) {
      try {
        yield { ready: true };
        await untilAborted(signal);
      } finally {
        entered.resolve();
        await cleanup.promise;
      }
    },
  });
  const server = createServer({ port: 0, rawRoutes: [route], logging: false });
  const reader = await open(`${server.url}/probe`);
  const shutdown = server.shutdown({ gracePeriodMs: 500 });
  await entered.promise;
  expect(server.status.pendingRequests).toBe(1);
  expect(server.status.completedRequests).toBe(0);
  cleanup.resolve();
  expect((await shutdown).outcome).toBe('clean');
  expect(server.status.pendingRequests).toBe(0);
  await reader.cancel();
});

test('client disconnect settles the source before later managed shutdown', async () => {
  const returned = Promise.withResolvers<void>();
  const server = createServer({
    port: 0,
    logging: false,
    rawRoutes: [
      streamingRoute({
        path: '/probe',
        source: async function* (_request, { signal }) {
          try {
            yield { ready: true };
            await untilAborted(signal);
          } finally {
            returned.resolve();
          }
        },
      }),
    ],
  });
  const client = new AbortController();
  const reader = await open(`${server.url}/probe`, client.signal);
  client.abort();
  await returned.promise;
  expect((await server.shutdown({ gracePeriodMs: 500 })).outcome).toBe('clean');
  expect(server.status.completedRequests).toBe(1);
  await reader.cancel().catch(() => undefined);
});

test('non-cooperative contract source remains pending after bounded force failure', async () => {
  const release = Promise.withResolvers<void>();
  const waiting = Promise.withResolvers<void>();
  const returned = Promise.withResolvers<void>();
  const contract = defineContract(
    { prefix: 'probe' },
    {
      events: { method: 'GET', path: '/', desc: 'Observe', stream: { item: Item } },
    },
  );
  const server = createServer({
    port: 0,
    logging: false,
    services: [
      implement(contract, {
        events: async function* () {
          try {
            yield { ready: true };
            waiting.resolve();
            await release.promise;
          } finally {
            returned.resolve();
          }
        },
      }),
    ],
  });
  const reader = await open(`${server.url}/probe`);
  await waiting.promise;
  try {
    await expect(server.shutdown({ gracePeriodMs: 20, forceTimeoutMs: 30 })).rejects.toThrow(
      'forced shutdown did not complete within 30ms',
    );
    expect(server.status.state).toBe('forced');
    expect(server.status.pendingRequests).toBe(1);
    expect(server.status.completedRequests).toBe(0);
  } finally {
    release.resolve();
    await returned.promise;
    await reader.cancel().catch(() => undefined);
  }
});

test('source cleanup error is not reported as a clean managed shutdown', async () => {
  const server = createServer({
    port: 0,
    logging: false,
    rawRoutes: [
      streamingRoute({
        path: '/probe',
        source: async function* (_request, { signal }) {
          try {
            yield { ready: true };
            await untilAborted(signal);
          } finally {
            await Promise.reject(new Error('source cleanup failed'));
          }
        },
      }),
    ],
  });
  const reader = await open(`${server.url}/probe`);
  await expect(server.shutdown({ gracePeriodMs: 200, forceTimeoutMs: 200 })).rejects.toThrow();
  expect(server.status.state).toBe('forced');
  await reader.cancel();
});

test('a cooperative source rejecting with its abort reason still closes cleanly', async () => {
  const contract = defineContract(
    { prefix: 'probe' },
    {
      events: { method: 'GET', path: '/', desc: 'Observe', stream: { item: Item } },
    },
  );
  const server = createServer({
    port: 0,
    logging: false,
    services: [
      implement(contract, {
        events: async function* ({ signal }) {
          if (!signal) throw new Error('Expected operation signal');
          yield { ready: true };
          await untilAborted(signal);
          signal.throwIfAborted();
        },
      }),
    ],
  });
  const reader = await open(`${server.url}/probe`);
  expect((await server.shutdown({ gracePeriodMs: 500 })).outcome).toBe('clean');
  await reader.cancel();
});

test('shutdown cancels an admitted async stream factory before its response exists', async () => {
  const entered = Promise.withResolvers<void>();
  let aborted = false;
  const server = createServer({
    port: 0,
    logging: false,
    rawRoutes: [
      streamingRoute({
        path: '/probe',
        async source(_request, { signal }) {
          entered.resolve();
          await untilAborted(signal);
          aborted = signal.aborted;
          return (async function* () {
            yield { ready: true };
          })();
        },
      }),
    ],
  });
  const response = fetch(`${server.url}/probe`);
  await entered.promise;
  expect((await server.shutdown({ gracePeriodMs: 500 })).outcome).toBe('clean');
  expect(aborted).toBe(true);
  expect(server.status.completedRequests).toBe(1);
  await (await response).text();
});

test('contract lifetime bounds the wire even when source cleanup ignores cancellation', async () => {
  const release = Promise.withResolvers<void>();
  const returned = Promise.withResolvers<void>();
  const contract = defineContract(
    { prefix: 'probe' },
    {
      events: {
        method: 'GET',
        path: '/',
        desc: 'Observe',
        stream: { item: Item, lifetimeMs: 30 },
      },
    },
  );
  const server = createServer({
    port: 0,
    logging: false,
    services: [
      implement(contract, {
        events: async function* () {
          try {
            yield { ready: true };
            await release.promise;
          } finally {
            returned.resolve();
          }
        },
      }),
    ],
  });
  const client = new AbortController();
  const reader = await open(`${server.url}/probe`, client.signal);
  const watchdog = setTimeout(() => client.abort(), 1_000);
  try {
    while (!(await reader.read()).done) {
      /* The wire deadline is independent of cleanup. */
    }
    expect(client.signal.aborted).toBe(false);
    expect(server.status.pendingRequests).toBe(1);
  } finally {
    clearTimeout(watchdog);
    release.resolve();
    await returned.promise;
    expect((await server.shutdown({ gracePeriodMs: 500 })).outcome).toBe('clean');
    await reader.cancel().catch(() => undefined);
  }
});
