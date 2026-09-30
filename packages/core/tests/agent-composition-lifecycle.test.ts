import { expect, test } from 'bun:test';
import { bindRealtimeClient } from '../src/browser/realtime-client';
import { createSocketIOClient } from '../src/browser/socket-io';
import {
  agentControlRealtimeContract,
  createAgentController,
} from '../src/entrypoints/agent-runtime/browser';
import { createAgentHarnessControlServer } from '../src/entrypoints/agent-runtime/harness';
import { bindAgentHarnessRealtime } from '../src/entrypoints/agent-runtime/realtime';
import { createServer } from '../src/server/bun';
import { createSocketIOServer } from '../src/server/socket-io';
import { compositionHarness, eventually } from './support/agent-composition';

test('failed snapshot after cancelled attachment cannot poison later attaches or retain a lease', async () => {
  const actual = compositionHarness();
  const barrier = Promise.withResolvers<void>();
  let blocked = false;
  const harness = {
    ...actual,
    async snapshot(id: string) {
      if (!blocked) {
        blocked = true;
        await barrier.promise;
        throw new Error('snapshot failed');
      }
      return actual.snapshot(id);
    },
  };
  const server = createAgentHarnessControlServer(harness);
  const connection = server.connect({
    id: 'one',
    deliver: () => undefined,
    onOverflow: () => undefined,
  });
  const other = server.connect({
    id: 'two',
    deliver: () => undefined,
    onOverflow: () => undefined,
  });
  try {
    const pending = connection.request({
      schemaVersion: 1,
      requestId: 'first',
      operation: 'attach',
      conversationId: 'one',
      access: 'control',
    });
    await eventually(() => blocked);
    expect(
      (
        await connection.request({
          schemaVersion: 1,
          requestId: 'detach',
          operation: 'detach',
          conversationId: 'one',
        })
      ).outcome,
    ).toBe('ok');
    barrier.resolve();
    expect((await pending).outcome).toBe('error');
    expect(
      (
        await connection.request({
          schemaVersion: 1,
          requestId: 'retry',
          operation: 'attach',
          conversationId: 'one',
          access: 'control',
        })
      ).outcome,
    ).toBe('ok');
    connection.close();
    expect(
      (
        await other.request({
          schemaVersion: 1,
          requestId: 'other',
          operation: 'attach',
          conversationId: 'one',
          access: 'control',
        })
      ).outcome,
    ).toBe('ok');
  } finally {
    barrier.resolve();
    server.close();
    await actual.close();
  }
});

test('closing during authorization or snapshot cancels attachment without leaking a lease', async () => {
  for (const delay of ['authorization', 'snapshot']) {
    const actual = compositionHarness();
    const barrier = Promise.withResolvers<void>();
    let blocked = false;
    const harness = {
      ...actual,
      async snapshot(id: string) {
        if (delay === 'snapshot' && !blocked) {
          blocked = true;
          await barrier.promise;
        }
        return actual.snapshot(id);
      },
    };
    const socket = await createSocketIOServer({});
    const binding = bindAgentHarnessRealtime(harness, socket, {
      authorize: async ({ request }) => {
        if (delay === 'authorization' && request.operation === 'attach' && !blocked) {
          blocked = true;
          await barrier.promise;
        }
        return { context: { owner: 'alice' } };
      },
    });
    const server = createServer({ port: 0, socket });
    const make = () =>
      createSocketIOClient({
        url: `http://localhost:${server.port}`,
        transports: ['websocket'],
      });
    const transport = make();
    const other = make();
    const first = createAgentController({
      transport,
      conversationId: 'alice',
      access: 'control',
    });
    const second = createAgentController({
      transport: other,
      conversationId: 'alice',
      access: 'control',
    });
    try {
      transport.connect();
      await eventually(() => blocked);
      await first.close();
      expect(transport.connected).toBe(true);
      barrier.resolve();
      other.connect();
      await eventually(() => second.getSnapshot().status === 'ready');
      expect(second.getSnapshot().error).toBeUndefined();
    } finally {
      barrier.resolve();
      transport.disconnect();
      other.disconnect();
      await first.close();
      await second.close();
      binding.close();
      await actual.close();
      await server.shutdown({ gracePeriodMs: 0 });
    }
  }
});

test('denied conversation leaves an authorized view on the shared socket usable and observer cannot mutate', async () => {
  const harness = compositionHarness();
  const socket = await createSocketIOServer({});
  const binding = bindAgentHarnessRealtime(harness, socket, {
    authorize: ({ request }) =>
      request.conversationId === 'alice' ? { context: { owner: 'alice' } } : null,
  });
  const server = createServer({ port: 0, socket });
  const transport = createSocketIOClient({
    url: `http://localhost:${server.port}`,
    transports: ['websocket'],
  });
  const good = createAgentController({
    transport,
    conversationId: 'alice',
    access: 'observe',
  });
  const bad = createAgentController({ transport, conversationId: 'other', access: 'control' });
  try {
    transport.connect();
    await eventually(
      () => good.getSnapshot().status === 'ready' && bad.getSnapshot().status === 'error',
    );
    expect((await good.request({ operation: 'snapshot' })).outcome).toBe('ok');
    expect(
      await good.request({
        operation: 'submit',
        idempotencyKey: 'denied',
        parts: [{ type: 'text', text: 'no' }],
      }),
    ).toMatchObject({ outcome: 'error', error: { code: 'LEASE_REQUIRED' } });
    expect(
      await good.request({
        operation: 'respond-approval',
        approvalId: 'unowned',
        approved: true,
      }),
    ).toMatchObject({ outcome: 'error', error: { code: 'LEASE_REQUIRED' } });
    expect((await harness.snapshot('alice')).runs).toHaveLength(0);
  } finally {
    transport.disconnect();
    await good.close();
    await bad.close();
    binding.close();
    await harness.close();
    await server.shutdown({ gracePeriodMs: 0 });
  }
});

test('server bounds pending requests and authorization time while error observer cannot prevent safe rejection', async () => {
  const harness = compositionHarness();
  const socket = await createSocketIOServer({});
  const seen: unknown[] = [];
  const binding = bindAgentHarnessRealtime(harness, socket, {
    maxPendingRequests: 1,
    authorizationTimeoutMs: 20,
    authorize: () =>
      new Promise(() => {
        /* Deliberately never settles: the framework must bound it. */
      }),
    onError(error) {
      seen.push(error);
      throw new Error('observer failure');
    },
  });
  const server = createServer({ port: 0, socket });
  const transport = createSocketIOClient({
    url: `http://localhost:${server.port}`,
    transports: ['websocket'],
  });
  try {
    transport.connect();
    await eventually(() => transport.connected);
    const client = bindRealtimeClient(agentControlRealtimeContract, transport);
    const request = (id: string) =>
      client.request(
        'agent:control',
        {
          schemaVersion: 1,
          requestId: id,
          operation: 'attach',
          conversationId: 'alice',
          access: 'control',
        },
        { timeoutMs: 1_000 },
      );
    const first = request('first');
    const second = request('second');
    expect(await second).toMatchObject({
      outcome: 'error',
      error: { code: 'REQUEST_CAPACITY' },
    });
    expect(await first).toMatchObject({ outcome: 'error', error: { code: 'ACCESS_DENIED' } });
    expect(seen).toHaveLength(1);
  } finally {
    transport.disconnect();
    binding.close();
    await harness.close();
    await server.shutdown({ gracePeriodMs: 0 });
  }
});
