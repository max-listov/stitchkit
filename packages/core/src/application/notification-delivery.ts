import { z } from 'zod';
import type {
  NotificationOutboxItem,
  NotificationOutboxState,
  NotificationSend,
} from './notification-outbox';
import type { StateStore } from './state-store';

export const NotificationDeliveryStateSchema = z
  .object({
    version: z.string().min(1).max(128),
    actions: z.array(z.string().min(1).max(128)).min(1).max(128),
    receipts: z.array(z.object({ action: z.string(), receipt: z.json() }).strict()).max(128),
    projectedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.actions).size === value.actions.length &&
      new Set(value.receipts.map((receipt) => receipt.action)).size ===
        value.receipts.length &&
      value.receipts.every((receipt) => value.actions.includes(receipt.action)),
    'Invalid action plan or receipts',
  );
export type NotificationDeliveryState = z.infer<typeof NotificationDeliveryStateSchema>;

export interface NotificationDeliveryConfig<TPayload> {
  readonly version: string;
  readonly actions: (payload: TPayload) => readonly string[];
  readonly project: (
    notification: NotificationSend<TPayload>,
    receipts: NotificationDeliveryState['receipts'],
  ) => void | Promise<void>;
}

/** Immutable plan captured at enqueue, never recomputed on retry. */
export function notificationDeliveryPlan<T>(
  config: NotificationDeliveryConfig<T>,
  payload: T,
): NotificationDeliveryState {
  return NotificationDeliveryStateSchema.parse({
    version: config.version,
    actions: [...config.actions(payload)],
    receipts: [],
  });
}

/** Checkpoints remain in the owning outbox's atomic state boundary. */
export async function deliverNotification<T>(input: {
  item: NotificationOutboxItem<T>;
  store: StateStore<NotificationOutboxState<T>>;
  config: NotificationDeliveryConfig<T>;
  send(notification: NotificationSend<T>): unknown | Promise<unknown>;
  clock(): Date;
  leaseMs: number;
  active(): boolean;
  bounded(state: NotificationOutboxState<T>): NotificationOutboxState<T>;
}): Promise<boolean> {
  const { item, config } = input;
  const plan = item.delivery;
  if (!plan || plan.version !== config.version)
    throw new Error('Notification action plan version does not match the executor');
  const owns = (current: NotificationOutboxItem<T>) =>
    current.key === item.key && current.leaseId === item.leaseId;
  const checkpoint = async (
    change: (plan: NotificationDeliveryState) => NotificationDeliveryState,
  ): Promise<boolean> =>
    input.store.update((state) => {
      if (!state) throw new Error('Outbox state disappeared');
      const live = state.queue.find(owns);
      if (!live?.delivery) return { state, result: false };
      const delivery = NotificationDeliveryStateSchema.parse(change(live.delivery));
      return {
        state: input.bounded({
          ...state,
          queue: state.queue.map((row) =>
            row === live
              ? {
                  ...row,
                  delivery,
                  leaseUntil: new Date(input.clock().getTime() + input.leaseMs).toISOString(),
                }
              : row,
          ),
        }),
        result: true,
      };
    });
  const notification = { key: item.key, payload: item.payload, attempt: item.attempts };
  for (const action of plan.actions) {
    if (!input.active()) return false;
    if (plan.receipts.some((receipt) => receipt.action === action)) continue;
    if (!(await checkpoint((value) => value))) return false;
    const result = await input.send({
      ...notification,
      action,
      idempotencyKey: JSON.stringify([item.key, plan.version, action]),
    });
    const receipt = z.json().parse(result ?? null);
    if (
      !(await checkpoint((value) => ({
        ...value,
        receipts: [...value.receipts, { action, receipt }],
      })))
    )
      return false;
  }
  if (!input.active()) return false;
  const current = await input.store.read();
  const live = current?.queue.find(owns);
  if (!live?.delivery) return false;
  if (live.delivery.projectedAt === undefined) {
    await config.project(notification, live.delivery.receipts);
    if (
      !(await checkpoint((value) => ({ ...value, projectedAt: input.clock().toISOString() })))
    )
      return false;
  }
  return true;
}
