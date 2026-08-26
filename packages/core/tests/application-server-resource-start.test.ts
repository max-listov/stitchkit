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
