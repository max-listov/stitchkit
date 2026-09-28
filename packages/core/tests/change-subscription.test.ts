import { expect, test } from 'bun:test';
import {
  type ChangeConnection,
  changeSubscriptionResource,
} from '../src/application/change-subscription';
import { deferred, resourceContext, until } from './session-delivery-fixture';

test('managed subscription reconciles lost hints, coalesces a burst and retries without another event', async () => {
  let hint: (key: string) => void = () => undefined;
  let disconnect: (error: unknown) => void = () => undefined;
  let connections = 0;
  let closed = 0;
  let reads = 0;
  let active = 0;
  let maxActive = 0;
  let value = 0;
  let published = -1;
  const errors: unknown[] = [];
  const health: string[] = [];
  const first = deferred<void>();
  const started = deferred<void>();
  const resource = changeSubscriptionResource({
    id: 'subscription',
    keys: ['items'],
    reconcileIntervalMs: 20,
    backoff: { minDelayMs: 2, maxDelayMs: 2, jitter: 0 },
    timeoutMs: 1000,
    async connect() {
      connections++;
      return {
        async subscribe(input) {
          hint = input.hint;
          disconnect = input.disconnected;
        },
        close() {
          closed++;
        },
      };
    },
    async reconcile(key, context) {
      expect(key).toBe('items');
      reads++;
      active++;
      maxActive = Math.max(active, maxActive);
      try {
        if (reads === 1) {
          started.resolve();
          await first.promise;
          throw new Error('read failed');
        }
        context.commit(() => {
          published = value;
        });
      } finally {
        active--;
      }
    },
    onError: (error) => {
      errors.push(error);
    },
  });
  try {
    await resource.start(resourceContext(health)).ready;
    await started.promise;
    for (let i = 0; i < 100; i++) hint('items');
    first.resolve();
    await until(() => published === 0);
    expect(maxActive).toBe(1);
    value = 9;
    await until(() => published === 9); // No hint, connection remains alive.
    expect(connections).toBe(1);
    hint('unknown');
    expect(errors).toHaveLength(2);
    const previousDisconnect = disconnect;
    disconnect(new Error('transport lost'));
    await until(() => connections === 2);
    expect(closed).toBe(1);
    const errorCount = errors.length;
    previousDisconnect(new Error('late old connection error'));
    expect(errors).toHaveLength(errorCount);
    expect(health).toContain('degraded');
  } finally {
    first.resolve();
    await resource.close();
  }
  expect(closed).toBe(2);
});

test('close during connect or subscribe closes the late handle and never resurrects delivery', async () => {
  for (const stage of ['connect', 'subscribe']) {
    const barrier = deferred<void>();
    const arrived = deferred<void>();
    let closes = 0;
    let reads = 0;
    const connection: ChangeConnection = {
      async subscribe() {
        if (stage === 'subscribe') {
          arrived.resolve();
          await barrier.promise;
        }
      },
      close() {
        closes++;
      },
    };
    const resource = changeSubscriptionResource({
      id: 'late',
      keys: ['x'],
      reconcileIntervalMs: 1000,
      async connect() {
        if (stage === 'connect') {
          arrived.resolve();
          await barrier.promise;
        }
        return connection;
      },
      async reconcile() {
        reads++;
      },
      onError: () => undefined,
    });
    const ready = resource.start(resourceContext()).ready?.catch((error) => error);
    await arrived.promise;
    await resource.close();
    barrier.resolve();
    expect(await ready).toBeInstanceOf(Error);
    expect(closes).toBe(1);
    expect(reads).toBe(0);
  }
});

test('managed subscription fences late publication and bounds keys and connection deadlines', async () => {
  const barrier = deferred<void>();
  const started = deferred<void>();
  let committed = true;
  const resource = changeSubscriptionResource({
    id: 'fence',
    keys: ['jobs'],
    reconcileIntervalMs: 1000,
    async connect() {
      return {
        async subscribe() {
          /* Fixture intentionally performs no work. */
        },
        close() {
          /* Fixture intentionally performs no work. */
        },
      };
    },
    async reconcile(_, context) {
      started.resolve();
      await barrier.promise;
      committed = context.commit(() => {
        throw new Error('stale');
      });
    },
    onError: () => undefined,
  });
  await resource.start(resourceContext()).ready;
  await started.promise;
  await resource.close();
  barrier.resolve();
  await until(() => !committed);
  expect(committed).toBe(false);
  expect(() =>
    changeSubscriptionResource({
      id: 'bad',
      keys: ['a', 'a'],
      reconcileIntervalMs: 100,
      connect: async () => {
        throw new Error('unused');
      },
      reconcile: async () => undefined,
      onError: () => undefined,
    }),
  ).toThrow('unique');
  const connect = deferred<ChangeConnection>();
  const errors: unknown[] = [];
  let closes = 0;
  const stalled = changeSubscriptionResource({
    id: 'timeout',
    keys: ['x'],
    reconcileIntervalMs: 1000,
    timeoutMs: 5,
    connect: () => connect.promise,
    reconcile: async () => undefined,
    onError: (e) => {
      errors.push(e);
    },
  });
  const ready = stalled.start(resourceContext()).ready?.catch((error) => error);
  await until(() => errors.length > 0);
  await stalled.close();
  connect.resolve({
    async subscribe() {
      throw new Error('late subscribe');
    },
    close() {
      closes++;
    },
  });
  expect(await ready).toBeInstanceOf(Error);
  await until(() => closes === 1);
  expect(closes).toBe(1);
  expect(String(errors[0])).toContain('deadline');
});

test('a lost connection whose close fails is still replaced', async () => {
  let disconnect: (error: unknown) => void = () => undefined;
  let connections = 0;
  const errors: string[] = [];
  const resource = changeSubscriptionResource({
    id: 'subscription',
    keys: ['items'],
    reconcileIntervalMs: 1_000,
    backoff: { minDelayMs: 2, maxDelayMs: 2, jitter: 0 },
    timeoutMs: 1_000,
    async connect() {
      connections++;
      const failsToClose = connections === 1;
      return {
        async subscribe(input) {
          disconnect = input.disconnected;
        },
        close() {
          if (failsToClose) throw new Error('close failed');
        },
      };
    },
    async reconcile() {
      /* Fixture intentionally performs no work. */
    },
    onError: (error) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  });
  try {
    await resource.start(resourceContext([])).ready;
    disconnect(new Error('socket dropped'));
    await until(() => connections === 2);
    expect(errors).toEqual(expect.arrayContaining(['socket dropped', 'close failed']));
  } finally {
    await resource.close();
  }
});
