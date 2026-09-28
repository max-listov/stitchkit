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

test('plans are immutable across attempts and a plan of an unknown version waits for its executor', async () => {
  const store = memoryState<NotificationOutboxState<Payload>>();
  let plans = 0;
  let sends = 0;
  let drops = 0;
  let now = Date.now();
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
    backoffMs: () => 0,
    clock: () => new Date(now),
  };
  const old = createNotificationOutbox(config);
  await old.enqueue({ key: 'x', payload: { text: 'x' } });
  const errors: unknown[] = [];
  const next = createNotificationOutbox({
    ...config,
    delivery: { version: 'two', actions: () => ['other'], project: () => undefined },
    onError: (error) => {
      errors.push(error);
    },
  });
  expect(await next.flush()).toBe(0);
  expect(sends).toBe(0);
  expect(plans).toBe(1);
  expect(drops).toBe(0);
  expect(errors).toHaveLength(1);
  // The process that knows the plan — a rollback, the old side of a deploy —
  // still delivers it, with no attempt spent on the one that could not.
  now += 1_000;
  expect(await old.flush()).toBe(1);
  expect(sends).toBe(1);
});

test('an action that succeeded is never sent again, whatever its receipt', async () => {
  for (const [label, returned, unrecorded] of [
    ['not JSON', { messageId: 42, sentAt: new Date(0) }, 'not-json'],
    ['larger than the state', { body: 'x'.repeat(4_096) }, 'too-large'],
  ] as const) {
    const store = memoryState<NotificationOutboxState<Payload>>();
    const sent: string[] = [];
    const errors: unknown[] = [];
    const projected: unknown[] = [];
    const outbox = createNotificationOutbox<Payload>({
      store,
      payloadSchema: schema,
      maxStateBytes: 2_048,
      backoffMs: () => 0,
      send: ({ action }) => {
        sent.push(String(action));
        return returned;
      },
      delivery: {
        version: 'v1',
        actions: () => ['telegram'],
        project: (_, receipts) => {
          projected.push(...receipts);
        },
      },
      classify: () => ({ retryable: true }),
      onError: (error) => {
        errors.push(error);
      },
    });
    await outbox.enqueue({ key: label, payload: { text: 'hi' } });
    expect(await outbox.flush()).toBe(1);
    expect(sent).toEqual(['telegram']);
    expect(projected).toEqual([{ action: 'telegram', receipt: null, unrecorded }]);
    expect(errors).toHaveLength(1);
  }
});

test('a retired plan version drains through its projection; an unknown one waits without classify', async () => {
  const store = memoryState<NotificationOutboxState<Payload>>();
  const sent: string[] = [];
  const projectedBy: string[] = [];
  const dropped: unknown[] = [];
  let classified = 0;
  const base: NotificationOutboxConfig<Payload> = {
    store,
    payloadSchema: schema,
    send: ({ action }) => {
      sent.push(String(action));
    },
    delivery: {
      version: 'one',
      actions: () => ['notify'],
      project: () => {
        projectedBy.push('one');
      },
    },
    classify: () => {
      classified++;
      return { retryable: true };
    },
    onDropped: ({ error }) => {
      dropped.push(error);
    },
  };
  const old = createNotificationOutbox(base);
  await old.enqueue({ key: 'queued-under-one', payload: { text: 'x' } });
  const next = createNotificationOutbox({
    ...base,
    delivery: {
      version: 'two',
      actions: () => ['other'],
      project: () => {
        projectedBy.push('two');
      },
      retiredVersions: { one: () => void projectedBy.push('retired one') },
    },
  });
  await next.enqueue({ key: 'queued-under-two', payload: { text: 'y' } });
  expect(await next.flush()).toBe(2);
  expect(sent).toEqual(['notify', 'other']);
  expect(projectedBy).toEqual(['retired one', 'two']);

  await old.enqueue({ key: 'orphan', payload: { text: 'z' } });
  const reported: unknown[] = [];
  const forgetful = createNotificationOutbox({
    ...base,
    delivery: { version: 'three', actions: () => ['other'], project: () => undefined },
    onError: (error) => {
      reported.push(error);
    },
  });
  expect(await forgetful.flush()).toBe(0);
  expect(classified).toBe(0);
  expect(dropped).toHaveLength(0);
  expect(String(reported[0])).toContain('"one" has no executor');
  expect((await store.read())?.queue.map((item) => item.key)).toEqual(['orphan']);
});

test('a store failure while recording a receipt is not mistaken for a receipt too large', async () => {
  const inner = memoryState<NotificationOutboxState<Payload>>();
  let failNext = false;
  let writes = 0;
  let sends = 0;
  const store: typeof inner = {
    read: () => inner.read(),
    update: (change) => {
      writes++;
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error('EBUSY'));
      }
      return inner.update(change);
    },
  };
  const projected: unknown[] = [];
  const outbox = createNotificationOutbox<Payload>({
    store,
    payloadSchema: schema,
    backoffMs: () => 0,
    send: () => {
      sends++;
      failNext = sends === 1;
      return { remoteId: 7 };
    },
    delivery: {
      version: 'v1',
      actions: () => ['telegram'],
      project: (_, receipts) => {
        projected.push(...receipts);
      },
    },
    classify: () => ({ retryable: true }),
  });
  await outbox.enqueue({ key: 'k', payload: { text: 'hi' } });
  await outbox.flush();
  expect(writes).toBeGreaterThan(0);
  expect(projected).not.toContainEqual(expect.objectContaining({ unrecorded: 'too-large' }));
});
