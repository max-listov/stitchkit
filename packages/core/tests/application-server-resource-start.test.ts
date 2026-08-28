import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createApplication } from '../src/application/kernel';
import { defineManagedResource } from '../src/application/resource';
import { managedServerResource } from '../src/application/server-resource';
import { defineContract } from '../src/contract';
import { createServer, implement } from '../src/server';
import type {
  ManagedServerHandle,
  ShutdownOptions,
  ShutdownResult,
} from '../src/server/shutdown';

const contract = defineContract(
  { prefix: 'lifecycle' },
  {
    ping: {
      method: 'GET',
      path: '/',
      desc: 'Answer while the application is up',
      output: z.object({ ok: z.boolean() }),
    },
  },
);

const service = implement(contract, { ping: () => ({ ok: true }) });

const cleanResult: ShutdownResult = {
  outcome: 'clean',
  acceptedRequests: 0,
  completedRequests: 0,
  pendingRequests: 0,
  pendingWebSockets: 0,
  pendingRequestsAtForce: 0,
  pendingWebSocketsAtForce: 0,
  abortedRequests: 0,
  forcedWebSockets: 0,
  durationMs: 0,
};

function fakeServer(calls: ShutdownOptions[]): ManagedServerHandle<undefined> {
  return {
    url: 'http://fake',
    port: 0,
    runtime: undefined,
    status: {
      state: 'running',
      acceptedRequests: 0,
      completedRequests: 0,
      pendingRequests: 0,
      pendingWebSockets: 0,
    },
    shutdown: (options) => {
      calls.push(options ?? {});
      return Promise.resolve(cleanResult);
    },
  };
}

describe('managedServerResource owns when the server exists', () => {
  test('a factory reads its declared dependency value and startup signal', async () => {
    const calls: ShutdownOptions[] = [];
    const database = defineManagedResource({
      id: 'database',
      start: () => ({ value: { message: 'ready' } }),
    });
    let factorySignal: AbortSignal | undefined;
    const http = managedServerResource({
      id: 'http',
      dependsOn: [database],
      server: (context) => {
        const dependency: { message: string } = context.use(database);
        expect(dependency.message).toBe('ready');
        expect(context.signal.aborted).toBe(false);
        factorySignal = context.signal;
        return fakeServer(calls);
      },
    });
    const app = createApplication({ id: 'factory-context', resources: [database, http] });

    await app.start();
    expect(factorySignal?.aborted).toBe(false);
    await app.shutdown();
    expect(factorySignal?.aborted).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test('an async factory receives the same typed context before dependants start', async () => {
    const calls: ShutdownOptions[] = [];
    const dependency = defineManagedResource({
      id: 'dependency',
      start: () => ({ value: { sequence: 7 } }),
    });
    const order: string[] = [];
    const http = managedServerResource({
      id: 'http',
      dependsOn: [dependency],
      server: async (context) => {
        await Promise.resolve();
        const value: { sequence: number } = context.use(dependency);
        order.push(`factory:${value.sequence}`);
        return fakeServer(calls);
      },
    });
    const app = createApplication({
      id: 'async-factory-context',
      resources: [
        dependency,
        http,
        defineManagedResource({
          id: 'dependant',
          dependsOn: [http],
          start: () => void order.push('dependant'),
        }),
      ],
    });

    await app.start();
    expect(order).toEqual(['factory:7', 'dependant']);
    await app.shutdown();
  });

  test('an undeclared dependency read fails once and preserves the factory error', async () => {
    const dependency = defineManagedResource({
      id: 'dependency',
      start: () => ({ value: { message: 'ready' } }),
    });
    let calls = 0;
    const app = createApplication({
      id: 'factory-undeclared-dependency',
      resources: [
        dependency,
        managedServerResource({
          id: 'http',
          server: (context) => {
            calls += 1;
            context.use(dependency);
            return fakeServer([]);
          },
        }),
      ],
    });

    const error = await app.start().then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AggregateError);
    expect(error instanceof Error ? error.message : '').toContain(
      'without declaring it in dependsOn',
    );
    expect(calls).toBe(1);
  });

  test('a failed dependency prevents the server factory from binding', async () => {
    let calls = 0;
    const dependency = defineManagedResource({
      id: 'dependency',
      start: () => {
        throw new Error('dependency unavailable');
      },
    });
    const app = createApplication({
      id: 'factory-dependency-failure',
      resources: [
        dependency,
        managedServerResource({
          id: 'http',
          dependsOn: [dependency],
          server: () => {
            calls += 1;
            return fakeServer([]);
          },
        }),
      ],
    });

    await expect(app.start()).rejects.toThrow('dependency unavailable');
    expect(calls).toBe(0);
  });

  test('an async factory rejection is not invoked again during rollback', async () => {
    let calls = 0;
    const app = createApplication({
      id: 'async-factory-rejection',
      resources: [
        managedServerResource({
          id: 'http',
          server: async () => {
            calls += 1;
            await Promise.resolve();
            throw new Error('async bind failed');
          },
        }),
      ],
    });

    const error = await app.start().then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AggregateError);
    expect(error instanceof Error ? error.message : '').toBe('async bind failed');
    expect(calls).toBe(1);
  });

  test('a thunk binds the port during start, not during shutdown', async () => {
    // The decisive one. A healthy snapshot is exactly what the broken version
    // produced, so the assertion is not the snapshot — it is a request that has
    // to reach a listener only `start()` could have created.
    let created = 0;
    let url = '';
    let seenByDependant: ManagedServerHandle<unknown> | undefined;
    const http = managedServerResource({
      id: 'http',
      dependsOn: ['database'],
      server: () => {
        created += 1;
        const server = createServer({ port: 0, services: [service] });
        url = server.url;
        return server;
      },
    });
    const app = createApplication({
      id: 'thunk-server',
      resources: [
        defineManagedResource({ id: 'database', start: () => undefined }),
        http,
        defineManagedResource({
          id: 'probe',
          dependsOn: [http],
          start: (context) => {
            seenByDependant = context.use(http);
          },
        }),
      ],
    });

    const snapshot = await app.start();
    expect(snapshot.health).toBe('healthy');
    expect(created).toBe(1);
    expect(seenByDependant?.url).toBe(url);

    const response = await fetch(`${url}/lifecycle`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const result = await app.shutdown();
    expect(result.outcome).toBe('clean');
    expect(created).toBe(1);
    await expect(fetch(`${url}/lifecycle`)).rejects.toThrow();
  });

  test('an async thunk is awaited before dependants start', async () => {
    const order: string[] = [];
    let url = '';
    const http = managedServerResource({
      id: 'http',
      server: async () => {
        await Promise.resolve();
        order.push('server created');
        const server = createServer({ port: 0, services: [service] });
        url = server.url;
        return server;
      },
    });
    const app = createApplication({
      id: 'async-thunk',
      resources: [
        http,
        defineManagedResource({
          id: 'after',
          dependsOn: [http],
          start: (context) => {
            order.push(`after sees ${context.use(http).port > 0 ? 'a port' : 'nothing'}`);
          },
        }),
      ],
    });
    await app.start();
    expect(order).toEqual(['server created', 'after sees a port']);
    expect((await fetch(`${url}/lifecycle`)).status).toBe(200);
    await app.shutdown();
  });

  test('an already-created handle is adopted exactly as before', async () => {
    const calls: ShutdownOptions[] = [];
    const server = fakeServer(calls);
    const app = createApplication({
      id: 'eager-server',
      resources: [managedServerResource({ id: 'http', server })],
    });
    await app.start();
    expect(calls).toHaveLength(0);
    await app.shutdown();
    expect(calls).toHaveLength(1);
  });

  test('the spread workaround still shuts its own server down', async () => {
    // The shape the broken version forced on consumers: this resource's stop
    // phases over their own `start`, with the thunk reading a module-local. Its
    // `start` never runs, so the shutdown path must still be able to reach the
    // server. Breaking it would punish exactly the people who worked around the
    // bug being fixed here.
    const calls: ShutdownOptions[] = [];
    let handle: ManagedServerHandle<undefined> | undefined;
    const adapter = managedServerResource({
      id: 'http',
      server: () => {
        if (!handle) throw new Error('no server');
        return handle;
      },
    });
    const app = createApplication({
      id: 'spread-workaround',
      resources: [
        defineManagedResource({
          ...adapter,
          start: () => {
            handle = fakeServer(calls);
          },
        }),
      ],
    });
    await app.start();
    expect(calls).toHaveLength(0);
    await app.shutdown();
    expect(calls).toHaveLength(1);
  });

  test('a thunk that throws fails the startup instead of reporting healthy', async () => {
    const app = createApplication({
      id: 'thunk-throws',
      resources: [
        managedServerResource({
          id: 'http',
          server: () => {
            throw new Error('port already in use');
          },
        }),
      ],
    });
    await expect(app.start()).rejects.toThrow('port already in use');
    expect(app.getSnapshot().ready).toBe(false);
  });
});
