import { expect, test } from 'bun:test';
import { z } from 'zod';
import {
  createNotificationOutbox,
  type NotificationOutboxConfig,
  type NotificationOutboxState,
} from '../src/application/notification-outbox';
import { deferred, memoryState } from './session-delivery-fixture';

const schema = z.object({ text: z.string() });
type Payload = z.infer<typeof schema>;

test('action receipts survive restart and projection retry never repeats confirmed sends', async () => {
  const store = memoryState<NotificationOutboxState<Payload>>();
  const sent: string[] = [];
  let projects = 0;
  let now = Date.now();
  const config: NotificationOutboxConfig<Payload> = {
    store,
    payloadSchema: schema,
    clock: () => new Date(now),
    backoffMs: () => 0,
    send: ({ action, idempotencyKey }) => {
      sent.push(String(action));
      expect(idempotencyKey).toContain('notice');
      return { remoteId: sent.length };
    },
    delivery: {
      version: 'v1',
      actions: () => ['text', 'attachment'],
      project: (_, receipts) => {
        expect(receipts).toHaveLength(2);
        projects++;
        if (projects === 1) throw new Error('projection storage unavailable');
      },
    },
    classify: () => ({ retryable: true }),
    maxAttempts: 1,
  };
  // Retain the item after one projection failure, then reopen it as another process.
  const first = createNotificationOutbox({ ...config, maxAttempts: 3, backoffMs: () => 10 });
  await first.enqueue({ key: 'notice', payload: { text: 'hello' } });
  expect(await first.flush()).toBe(0);
  expect(sent).toEqual(['text', 'attachment']);
  const retained = await store.read();
  expect(retained?.queue[0]?.delivery?.receipts).toHaveLength(2);
  now += 10;
  const second = createNotificationOutbox({ ...config, maxAttempts: 3 });
  expect(await second.flush()).toBe(1);
  expect(sent).toEqual(['text', 'attachment']);
  const receipt = (await store.read())?.receipts[0];
  expect(receipt?.delivery?.projectedAt).toBeDefined();
  expect(receipt?.delivery?.receipts[1]?.receipt).toEqual({ remoteId: 2 });
});

test('a reclaimed lease refuses a late checkpoint; provider receives a stable reconciliation key', async () => {
  const store = memoryState<NotificationOutboxState<Payload>>();
  let now = Date.now();
  const started = deferred<void>();
  const release = deferred<void>();
  const ids: string[] = [];
  let sends = 0;
  const config: NotificationOutboxConfig<Payload> = {
    store,
    payloadSchema: schema,
    clock: () => new Date(now),
    leaseMs: 100,
    delivery: { version: 'v1', actions: () => ['upload'], project: () => undefined },
    classify: () => ({ retryable: false }),
    async send(input) {
      ids.push(String(input.idempotencyKey));
      sends++;
      if (sends === 1) {
        started.resolve();
        await release.promise;
      }
      return { remoteId: sends };
    },
  };
  const old = createNotificationOutbox(config);
  await old.enqueue({ key: 'asset', payload: { text: 'file' } });
  const pending = old.flush();
  await started.promise;
  now += 101;
  const fresh = createNotificationOutbox(config);
  expect(await fresh.flush()).toBe(1);
  release.resolve();
  expect(await pending).toBe(0);
  expect(ids[0]).toBe(ids[1]);
  expect((await store.read())?.receipts).toHaveLength(1);
});

test('plans are immutable across attempts and mismatched versions are quarantined through onDropped', async () => {
  const store = memoryState<NotificationOutboxState<Payload>>();
  let plans = 0;
  let sends = 0;
  let drops = 0;
  const config: NotificationOutboxConfig<Payload> = {
    store,
    payloadSchema: schema,
    delivery: {
      version: 'one',
      actions: () => {
        plans++;
        return ['notify'];
      },
      project: () => undefined,
    },
    send: () => {
      sends++;
    },
    classify: () => ({ retryable: false }),
    onDropped: () => {
      drops++;
    },
  };
  const old = createNotificationOutbox(config);
  await old.enqueue({ key: 'x', payload: { text: 'x' } });
  const next = createNotificationOutbox({
    ...config,
    delivery: { version: 'two', actions: () => ['other'], project: () => undefined },
  });
  expect(await next.flush()).toBe(0);
  expect(sends).toBe(0);
  expect(plans).toBe(1);
  expect(drops).toBe(1);
});
