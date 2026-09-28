import { z } from 'zod';
import type {
  NotificationOutboxItem,
  NotificationOutboxState,
  NotificationSend,
} from './notification-outbox';
import { OutboxStateLimitError } from './notification-outbox-state';
import type { StateStore } from './state-store';

export const NotificationDeliveryStateSchema = z
  .object({
    version: z.string().min(1).max(128),
    actions: z.array(z.string().min(1).max(128)).min(1).max(128),
    receipts: z
      .array(
        z
          .object({
            action: z.string(),
            receipt: z.json(),
            /**
             * The action succeeded but its result could not be kept: it was not
             * JSON, or it did not fit the outbox state. The action is still
             * confirmed and never sent again; `receipt` is then `null`.
             */
            unrecorded: z.enum(['not-json', 'too-large']).optional(),
          })
          .strict(),
      )
      .max(128),
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

export type NotificationProjection<TPayload> = (
  notification: NotificationSend<TPayload>,
  receipts: NotificationDeliveryState['receipts'],
) => void | Promise<void>;

export interface NotificationDeliveryConfig<TPayload> {
  readonly version: string;
  readonly actions: (payload: TPayload) => readonly string[];
  readonly project: NotificationProjection<TPayload>;
  /**
   * Projections of earlier plan versions still waiting in the queue. A plan
   * keeps its actions from enqueue, so an older version needs only its
   * projection to finish: keep it here until the queue has drained it.
   */
  readonly retiredVersions?: Readonly<Record<string, NotificationProjection<TPayload>>>;
}

/**
 * A queued plan whose version this executor does not know. It is reported to
 * `onError` and waits for an executor that knows it — a newer or older process
 * during a deploy or rollback, or this one once it lists the version in
 * `retiredVersions` — without counting an attempt or consulting `classify`.
 */
export class NotificationPlanVersionError extends Error {
  readonly version: string;

  constructor(version: string) {
    super(`Notification action plan version "${version}" has no executor`);
    this.name = 'NotificationPlanVersionError';
    this.version = version;
  }
}

function projectionFor<T>(
  config: NotificationDeliveryConfig<T>,
  version: string,
): NotificationProjection<T> | undefined {
  if (version === config.version) return config.project;
  return config.retiredVersions && Object.hasOwn(config.retiredVersions, version)
    ? config.retiredVersions[version]
    : undefined;
}

function recordable(result: unknown): {
  receipt: z.infer<ReturnType<typeof z.json>>;
  unrecorded?: 'not-json';
} {
  const parsed = z.json().safeParse(result ?? null);
  return parsed.success ? { receipt: parsed.data } : { receipt: null, unrecorded: 'not-json' };
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
  /** An action succeeded but its receipt could not be kept as returned. */
  report(error: unknown): Promise<void>;
}): Promise<boolean> {
  const { item, config } = input;
  const plan = item.delivery;
  if (!plan) throw new Error('Notification has no action plan');
  const project = projectionFor(config, plan.version);
  if (!project) throw new NotificationPlanVersionError(plan.version);
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
    // From here the action has happened. Nothing about its result may send it
    // again: a receipt that cannot be kept is recorded as unrecorded instead.
    const entry = recordable(result);
    const confirm = (receipt: NotificationDeliveryState['receipts'][number]) =>
      checkpoint((value) => ({ ...value, receipts: [...value.receipts, receipt] }));
    let confirmed: boolean;
    let dropped: unknown;
    try {
      confirmed = await confirm({ action, ...entry });
    } catch (error) {
      // Only a receipt too large for the state is given up; any other failure
      // to checkpoint is the store's and propagates as before.
      if (entry.unrecorded || !(error instanceof OutboxStateLimitError)) throw error;
      dropped = error;
      confirmed = await confirm({ action, receipt: null, unrecorded: 'too-large' });
    }
    // Reported after the checkpoint, so a slow observer cannot hold the lease
    // between a send and its record.
    if (dropped) await input.report(dropped);
    if (entry.unrecorded) {
      await input.report(
        new Error(`Notification action "${action}" returned a receipt that is not JSON`),
      );
    }
    if (!confirmed) return false;
  }
  if (!input.active()) return false;
  const current = await input.store.read();
  const live = current?.queue.find(owns);
  if (!live?.delivery) return false;
  if (live.delivery.projectedAt === undefined) {
    await project(notification, live.delivery.receipts);
    if (
      !(await checkpoint((value) => ({ ...value, projectedAt: input.clock().toISOString() })))
    )
      return false;
  }
  return true;
}
