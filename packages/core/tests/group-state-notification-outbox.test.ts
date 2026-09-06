import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  createNotificationOutbox,
  type NotificationOutboxState,
} from '../src/application/notification-outbox';
import type { StateStore } from '../src/application/state-store';

function memoryStore<TState>(initial: TState | null = null): StateStore<TState> {
  let state = initial;
  let tail = Promise.resolve();
  return {
    async read() {
      await tail;
      return state;
    },
    update(transition) {
      const result = tail.then(async () => {
        const next = await transition(state);
        state = next.state;
        return next.result;
      });
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

const PayloadSchema = z.object({ text: z.string() }).strict();
type Payload = z.infer<typeof PayloadSchema>;

describe('notification outbox', () => {
  test('deduplicates completed keys and supersedes pending notifications', async () => {
    const delivered: string[] = [];
    const outbox = createNotificationOutbox({
      store: memoryStore<NotificationOutboxState<Payload>>(),
      payloadSchema: PayloadSchema,
      send: ({ key }) => {
        delivered.push(key);
      },
      classify: () => ({ retryable: false }),
    });

    expect(await outbox.enqueue({ key: 'old', payload: { text: 'old' } })).toBeTrue();
    expect(
      await outbox.enqueue({ key: 'new', payload: { text: 'new' }, supersedes: ['old'] }),
    ).toBeTrue();
    expect(await outbox.flush()).toBe(1);
    expect(delivered).toEqual(['new']);
    expect(await outbox.enqueue({ key: 'new', payload: { text: 'again' } })).toBeFalse();
  });

  test('persists retry attempts and respects a fake-clock backoff', async () => {
    let now = new Date('2026-09-06T04:00:00.000Z');
    let attempts = 0;
    const store = memoryStore<NotificationOutboxState<Payload>>();
    const outbox = createNotificationOutbox({
      store,
      payloadSchema: PayloadSchema,
      clock: () => now,
      backoffMs: () => 5_000,
      send: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary');
      },
      classify: () => ({ retryable: true }),
    });

    await outbox.enqueue({ key: 'retry', payload: { text: 'hello' } });
    expect(await outbox.flush()).toBe(0);
    expect((await outbox.state()).queue[0]).toMatchObject({ attempts: 1 });
    expect(await outbox.flush()).toBe(0);
    now = new Date(now.getTime() + 5_000);
    expect(await outbox.flush()).toBe(1);
    expect(attempts).toBe(2);
  });

  test('a second process reclaims an expired crash lease with the same idempotency key', async () => {
    let now = new Date('2026-09-06T04:00:00.000Z');
    const store = memoryStore<NotificationOutboxState<Payload>>();
    const firstSend = Promise.withResolvers<void>();
    const firstStarted = Promise.withResolvers<void>();
    const observed: string[] = [];
    const first = createNotificationOutbox({
      store,
      payloadSchema: PayloadSchema,
      ownerId: 'process-a',
      leaseMs: 100,
      clock: () => now,
      send: async ({ key }) => {
        observed.push(`a:${key}`);
        firstStarted.resolve();
        await firstSend.promise;
      },
      classify: () => ({ retryable: true }),
    });
    const second = createNotificationOutbox({
      store,
      payloadSchema: PayloadSchema,
      ownerId: 'process-b',
      leaseMs: 100,
      clock: () => now,
      send: ({ key }) => {
        observed.push(`b:${key}`);
      },
      classify: () => ({ retryable: true }),
    });

    await first.enqueue({ key: 'stable-key', payload: { text: 'notice' } });
    const pendingFirst = first.flush();
    await firstStarted.promise;
    now = new Date(now.getTime() + 101);
    expect(await second.flush()).toBe(1);
    firstSend.resolve();
    expect(await pendingFirst).toBe(1);
    expect(observed).toEqual(['a:stable-key', 'b:stable-key']);
    expect((await second.state()).queue).toEqual([]);
  });

  test('serializes concurrent flushes and reports terminal drops once', async () => {
    const dropped: string[] = [];
    let concurrent = 0;
    let maximum = 0;
    const outbox = createNotificationOutbox({
      store: memoryStore<NotificationOutboxState<Payload>>(),
      payloadSchema: PayloadSchema,
      send: async () => {
        concurrent += 1;
        maximum = Math.max(maximum, concurrent);
        await Bun.sleep(2);
        concurrent -= 1;
        throw new Error('recipient gone');
      },
      classify: () => ({ retryable: false, recipientUnreachable: true }),
      onDropped: ({ item, reason }) => {
        dropped.push(`${item.key}:${reason}`);
      },
    });
    await outbox.enqueue({ key: 'one', payload: { text: '1' } });
    await outbox.enqueue({ key: 'two', payload: { text: '2' } });
    await Promise.all([outbox.flush(), outbox.flush(), outbox.flush()]);
    expect(maximum).toBe(1);
    expect(dropped).toEqual(['one:recipient-unreachable', 'two:recipient-unreachable']);
  });

  test('bounds attempts and payload state', async () => {
    const drops: string[] = [];
    const outbox = createNotificationOutbox({
      store: memoryStore<NotificationOutboxState<Payload>>(),
      payloadSchema: PayloadSchema,
      maxAttempts: 2,
      backoffMs: () => 0,
      send: () => {
        throw new Error('still unavailable');
      },
      classify: () => ({ retryable: true }),
      onDropped: ({ reason }) => {
        drops.push(reason);
      },
    });
    await outbox.enqueue({ key: 'bounded', payload: { text: 'small' } });
    await outbox.flush();
    expect(drops).toEqual(['attempt-limit']);
    expect((await outbox.state()).queue).toEqual([]);
  });

  test('trims delivery receipts to the hard state byte budget', async () => {
    const outbox = createNotificationOutbox({
      store: memoryStore<NotificationOutboxState<Payload>>(),
      payloadSchema: PayloadSchema,
      maxStateBytes: 1_024,
      retainReceipts: 100,
      send: () => undefined,
      classify: () => ({ retryable: false }),
    });
    for (let index = 0; index < 20; index += 1) {
      await outbox.enqueue({
        key: `${String(index).padStart(2, '0')}-${'k'.repeat(80)}`,
        payload: { text: 'x' },
      });
      await outbox.flush();
    }
    const state = await outbox.state();
    expect(state.receipts.length).toBeLessThan(20);
    expect(new TextEncoder().encode(JSON.stringify(state)).byteLength).toBeLessThanOrEqual(
      1_024,
    );
  });
  test('reading state never fails on the bounds a transition enforces', async () => {
    const oversized = memoryStore<NotificationOutboxState<Payload>>({
      schemaVersion: 1,
      queue: [],
      receipts: Array.from({ length: 50 }, (_, index) => ({
        key: `receipt-${index}-${'x'.repeat(64)}`,
        completedAt: '2026-09-06T04:00:00.000Z',
      })),
    });
    const outbox = createNotificationOutbox({
      store: oversized,
      payloadSchema: PayloadSchema,
      maxStateBytes: 1_024,
      send: () => undefined,
      classify: () => ({ retryable: false }),
    });
    // The file grew past the budget under an older limit: inspection must
    // still work, and the next transition trims it back under the budget.
    expect((await outbox.state()).receipts).toHaveLength(50);
    await outbox.enqueue({ key: 'trim', payload: { text: 'x' } });
    const trimmed = await outbox.state();
    expect(new TextEncoder().encode(JSON.stringify(trimmed)).byteLength).toBeLessThanOrEqual(
      1_024,
    );
  });

  test('the default attempt budget outlives a transport outage measured in an hour', async () => {
    let now = new Date('2026-09-06T04:00:00.000Z');
    const drops: string[] = [];
    let attempts = 0;
    const outbox = createNotificationOutbox({
      store: memoryStore<NotificationOutboxState<Payload>>(),
      payloadSchema: PayloadSchema,
      clock: () => now,
      send: () => {
        attempts += 1;
        throw new Error('transport down');
      },
      classify: () => ({ retryable: true }),
      onDropped: ({ reason }) => {
        drops.push(reason);
      },
    });
    await outbox.enqueue({ key: 'outage', payload: { text: 'owner notice' } });
    // Walk the clock past one hour, flushing whenever the backoff allows.
    for (let step = 0; step < 61; step += 1) {
      await outbox.flush();
      now = new Date(now.getTime() + 60_000);
    }
    expect(drops).toEqual([]);
    expect(attempts).toBeGreaterThan(50);
    expect((await outbox.state()).queue).toHaveLength(1);
  });
  test('stop() finishes the send in flight and claims nothing more', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const sent: string[] = [];
    const outbox = createNotificationOutbox({
      store: memoryStore<NotificationOutboxState<Payload>>(),
      payloadSchema: PayloadSchema,
      pollIntervalMs: 10,
      send: async ({ key }) => {
        sent.push(key);
        started.resolve();
        await release.promise;
      },
      classify: () => ({ retryable: true }),
    });
    await outbox.enqueue({ key: 'a', payload: { text: 'a' } });
    await outbox.enqueue({ key: 'b', payload: { text: 'b' } });
    outbox.start();
    await started.promise;
    const stopping = outbox.stop();
    release.resolve();
    await stopping;
    expect(sent).toEqual(['a']);
    expect((await outbox.state()).queue.map((item) => item.key)).toEqual(['b']);
  });
});
