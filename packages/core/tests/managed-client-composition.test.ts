import { expect, test } from 'bun:test';
import { createApplication } from '../src/application/kernel';
import { ApplicationAdmissionError } from '../src/application/kernel-contract';
import {
  defineManagedResource,
  type ManagedResourceContext,
} from '../src/application/resource';
import { deferred } from './application-directory-inbox-fixture';

interface Client {
  readonly generation: number;
  connect(signal: AbortSignal): Promise<void>;
  assertReady(): Promise<void>;
  invoke(): Promise<number>;
  destroy(): Promise<void>;
}

/** The client belongs to the application; this is a composition recipe, not an SDK adapter. */
function clientResource(create: () => Client) {
  let generation: { client: Client; destroy(): Promise<void> } | undefined;
  return defineManagedResource({
    id: 'client',
    async start({ signal }: ManagedResourceContext) {
      const client = create();
      let destruction: Promise<void> | undefined;
      const destroy = () => (destruction ??= Promise.resolve().then(() => client.destroy()));
      generation = { client, destroy };
      let ready = false;
      let startFailure: unknown;
      let startFailed = false;
      let cleanupFailed = false;
      let cleanupFailure: unknown;
      try {
        await client.connect(signal);
        await client.assertReady();
        signal.throwIfAborted();
        ready = true;
      } catch (error) {
        startFailure = error;
        startFailed = true;
      } finally {
        if (!ready) {
          try {
            await destroy();
          } catch (cleanup) {
            cleanupFailed = true;
            cleanupFailure = cleanup;
          }
        }
      }
      if (startFailed) {
        if (cleanupFailed)
          throw new AggregateError(
            [startFailure, cleanupFailure],
            'Client startup and cleanup failed',
            { cause: startFailure },
          );
        throw startFailure;
      }
      return { value: client };
    },
    close: () => generation?.destroy(),
    force: () => generation?.destroy(),
  });
}

function fixture(
  options: {
    connect?: () => Promise<void>;
    failReady?: boolean;
    failDestroy?: boolean;
    stuckDrain?: boolean;
  } = {},
) {
  const events: string[] = [];
  const clients: { id: number; destroys: number; connected: boolean }[] = [];
  const client = clientResource(() => {
    const state = { id: clients.length + 1, destroys: 0, connected: false };
    clients.push(state);
    return {
      generation: state.id,
      async connect(signal) {
        events.push(`connect:${state.id}`);
        await options.connect?.();
        signal.throwIfAborted();
        state.connected = true;
      },
      async assertReady() {
        if (options.failReady) throw new Error('readiness failed after allocation');
      },
      async invoke() {
        if (!state.connected) throw new Error('closed generation');
        return state.id;
      },
      async destroy() {
        state.destroys += 1;
        state.connected = false;
        events.push(`destroy:${state.id}`);
        if (options.failDestroy) throw new Error('destroy failed');
      },
    };
  });
  let request: (() => Promise<number>) | undefined;
  const http = defineManagedResource({
    id: 'http',
    dependsOn: [client],
    start(context) {
      const connection = context.use(client);
      // @ts-expect-error dependency publication keeps its exact client type
      const incorrect: string = connection.generation;
      void incorrect;
      events.push(`http:${connection.generation}`);
      request = async () => {
        const lease = context.admission.acquire();
        if (!lease) throw new ApplicationAdmissionError();
        try {
          return await connection.invoke();
        } finally {
          lease.release();
        }
      };
    },
    drain: () => (options.stuckDrain ? new Promise<void>(() => undefined) : undefined),
    close: () => {
      events.push('http:close');
    },
    force: () => {
      events.push('http:force');
    },
  });
  const app = createApplication({
    id: 'client-service',
    resources: [client, http],
    shutdown: { gracePeriodMs: 10, forceTimeoutMs: 100 },
  });
  return {
    app,
    client,
    clients,
    events,
    request: () => {
      if (!request) throw new Error('HTTP not bound');
      return request();
    },
  };
}

test('managed client readiness gates binding and requests; dependent HTTP closes before the client', async () => {
  const connect = deferred();
  const f = fixture({ connect: () => connect.promise });
  const starting = f.app.start();
  expect(f.app.admission.acquire()).toBeNull();
  expect(() => f.request()).toThrow('HTTP not bound');
  connect.resolve();
  await starting;
  expect(await f.request()).toBe(1);
  expect(f.clients[0]?.destroys).toBe(0);
  const stopping = f.app.shutdown();
  await expect(f.request()).rejects.toBeInstanceOf(ApplicationAdmissionError);
  expect(await stopping).toMatchObject({ outcome: 'clean' });
  expect(f.events.slice(-2)).toEqual(['http:close', 'destroy:1']);
  expect(f.clients[0]?.destroys).toBe(1);
});

test('partial startup cleanup and rollback share one memoized destroy invocation', async () => {
  const f = fixture({ failReady: true });
  await expect(f.app.start()).rejects.toThrow('readiness failed after allocation');
  await f.client.force();
  await f.client.close();
  expect(f.clients[0]?.destroys).toBe(1);
  expect(f.events).toEqual(['connect:1', 'destroy:1']);
});

test('cleanup failure retains the startup and destroy causes without a second destroy call', async () => {
  const f = fixture({ failReady: true, failDestroy: true });
  const failure = await f.app.start().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect(f.clients[0]?.destroys).toBe(1);
  await expect(f.client.force()).rejects.toThrow('destroy failed');
  expect(f.clients[0]?.destroys).toBe(1);
});

test('forced shutdown and any later close share one destroy promise for that generation', async () => {
  const f = fixture({ stuckDrain: true });
  await f.app.start();
  expect(await f.app.shutdown()).toMatchObject({ outcome: 'forced' });
  await f.client.close();
  await f.client.force();
  expect(f.clients[0]?.destroys).toBe(1);
  expect(f.events).toContain('http:force');
  await expect(f.request()).rejects.toBeInstanceOf(ApplicationAdmissionError);
});

test('subtree restart constructs a fresh client and resets destroy memoization per generation', async () => {
  const f = fixture();
  await f.app.start();
  expect(await f.request()).toBe(1);
  expect(await f.app.restart({ resourceId: 'client' })).toMatchObject({
    outcome: 'restarted',
    affected: ['client', 'http'],
  });
  expect(await f.request()).toBe(2);
  expect(f.clients.map((client) => client.destroys)).toEqual([1, 0]);
  await f.app.shutdown();
  expect(f.clients.map((client) => client.destroys)).toEqual([1, 1]);
});
