import { createSessionCredentials, createSessionScope, SessionExpiredError } from 'stitchkit';
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

const scope = createSessionScope<string>();
let stored: string | undefined;
const credentials = createSessionCredentials<string, string>({
  scope,
  refresh: async (value) => `${value}-refreshed`,
  storage: {
    async write(_, value) {
      stored = value;
    },
    async clear() {
      stored = undefined;
    },
  },
});
const first = await credentials.login('A', 'token');
if ((await credentials.refresh(first)) !== 'token-refreshed')
  throw new Error('Refresh failed');
await credentials.logout();
if (
  stored !== undefined ||
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
const store: StateStore<NotificationOutboxState<string>> = {
  read: async () => state,
  async update(transition) {
    const result = await transition(state);
    state = result.state;
    return result.result;
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
