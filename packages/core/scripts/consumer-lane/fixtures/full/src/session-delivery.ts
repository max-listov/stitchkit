import {
  createSessionCredentials,
  createSessionScope,
  type SessionClock,
  SessionExpiredError,
} from 'stitchkit';
import {
  changeSubscriptionResource,
  createNotificationOutbox,
  NotificationDeliveryStateSchema,
  type NotificationOutboxState,
  type StateStore,
} from 'stitchkit/application';
import { createWatchClient, WatchKeySchema } from 'stitchkit/live';
import { createCacheBridge, type WatchCacheBinding } from 'stitchkit/react';
import { z } from 'zod';

let wall = 0;
let mono = 0;
let timerSeq = 0;
const scheduled = new Map<number, { at: number; run: () => void }>();
const clock: SessionClock = {
  now: () => wall,
  monotonic: () => mono,
  schedule(run, delayMs) {
    const id = timerSeq++;
    scheduled.set(id, { at: mono + delayMs, run });
    return {
      cancel() {
        scheduled.delete(id);
      },
    };
  },
};
const advanceClock = async (ms: number) => {
  mono += ms;
  wall += ms;
  for (const [id, timer] of [...scheduled]) {
    if (timer.at > mono) continue;
    scheduled.delete(id);
    timer.run();
    for (let i = 0; i < 6; i++) await Promise.resolve();
  }
};

interface SessionToken {
  readonly value: string;
  readonly expiresAt: number | null;
}

const scope = createSessionScope<string>();
let stored: { session: string; credentials: SessionToken } | null = null;
const credentials = createSessionCredentials<string, SessionToken>({
  scope,
  clock,
  refreshAhead: { expiresAt: (token) => token.expiresAt, leadMs: 60_000 },
  refresh: async (token) => ({
    value: `${token.value}-refreshed`,
    expiresAt: wall + 600_000,
  }),
  storage: {
    async read() {
      return stored;
    },
    async write(session, value) {
      stored = { session, credentials: value };
    },
    async clear() {
      stored = null;
    },
  },
});
const first = await credentials.login('A', { value: 'token', expiresAt: 120_000 });
await advanceClock(60_000);
if (credentials.read(first).value !== 'token-refreshed')
  throw new Error('Proactive refresh failed');
const restored = await credentials.restore();
if (
  restored.status !== 'present' ||
  credentials.read(restored.operation).value !== 'token-refreshed'
)
  throw new Error('Restore failed');
await credentials.logout();
if (
  stored !== null ||
  scheduled.size !== 0 ||
  first.deliver(() => {
    throw new Error('Stale delivery');
  })
)
  throw new Error('Logout failed');
try {
  first.assertCurrent();
  throw new Error('Fence missing');
} catch (error) {
  if (!(error instanceof SessionExpiredError)) throw error;
}
let state: NotificationOutboxState<string> | null = null;
let stateTail: Promise<unknown> = Promise.resolve();
const store: StateStore<NotificationOutboxState<string>> = {
  read: async () => state,
  update(transition) {
    const pending = stateTail.then(async () => {
      let active = true;
      const context = {
        async assertHeld() {
          if (!active) throw new Error('Consumer state transaction ended');
        },
      };
      try {
        const result = await transition(state, context);
        await context.assertHeld();
        state = result.state;
        return result.result;
      } finally {
        active = false;
      }
    });
    stateTail = pending.catch(() => undefined);
    return pending;
  },
};
let sends = 0;
const outbox = createNotificationOutbox({
  store,
  payloadSchema: z.string(),
  delivery: { version: 'one', actions: () => ['send'], project: async () => undefined },
  send: async () => ({ id: ++sends }),
  classify: () => ({ retryable: false }),
});
await outbox.enqueue({ key: 'consumer', payload: 'payload' });
if ((await outbox.flush()) !== 1 || sends !== 1) throw new Error('Delivery failed');
const receipt = (await outbox.state()).receipts[0]?.delivery;
if (!NotificationDeliveryStateSchema.parse(receipt).projectedAt)
  throw new Error('Projection missing');
WatchKeySchema.parse({
  service: 'example',
  action: 'read',
  digest: 'hash',
  instance: first.id,
});
const bindings: WatchCacheBinding[] = [];
if (bindings.length || !createCacheBridge || !createWatchClient || !changeSubscriptionResource)
  throw new Error('Missing public exports');
console.log('session and delivery consumer: ok');
