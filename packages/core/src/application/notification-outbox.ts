import { z } from 'zod';
import { backoffDelay } from '../internal/backoff';
import {
  deliverNotification,
  type NotificationDeliveryConfig,
  type NotificationDeliveryState,
  NotificationDeliveryStateSchema,
  NotificationPlanVersionError,
  notificationDeliveryPlan,
} from './notification-delivery';
import {
  boundedOutboxState,
  claimDue,
  DEFAULT_OUTBOX_BACKOFF,
  dropReason,
  NO_LEASE,
  RetryDelaySchema,
  resolveOutboxLimits,
} from './notification-outbox-state';
import { defineManagedResource, type ManagedResource } from './resource';
import type { StateStore } from './state-store';

export interface NotificationOutboxItem<TPayload> {
  readonly delivery?: NotificationDeliveryState;
  readonly key: string;
  readonly payload: TPayload;
  readonly createdAt: string;
  readonly attempts: number;
  readonly nextAttemptAt: string;
  readonly leaseOwner: string | null;
  readonly leaseId: string | null;
  readonly leaseUntil: string | null;
}

export interface NotificationOutboxReceipt {
  readonly delivery?: NotificationDeliveryState;
  readonly key: string;
  readonly completedAt: string;
}

export interface NotificationOutboxState<TPayload> {
  readonly schemaVersion: 1;
  readonly queue: readonly NotificationOutboxItem<TPayload>[];
  readonly receipts: readonly NotificationOutboxReceipt[];
}

/** The schema shared by any persistence adapter and the outbox itself. */
export function notificationOutboxStateSchema<TPayload>(
  payload: z.ZodType<TPayload>,
): z.ZodType<NotificationOutboxState<TPayload>> {
  return z
    .object({
      schemaVersion: z.literal(1),
      queue: z.array(
        z
          .object({
            key: z.string().min(1).max(512),
            payload,
            delivery: NotificationDeliveryStateSchema.optional(),
            createdAt: z.string().datetime({ offset: true }),
            attempts: z.number().int().nonnegative(),
            nextAttemptAt: z.string().datetime({ offset: true }),
            leaseOwner: z.string().min(1).max(128).nullable(),
            leaseId: z.string().min(1).max(128).nullable(),
            leaseUntil: z.string().datetime({ offset: true }).nullable(),
          })
          .strict(),
      ),
      receipts: z.array(
        z
          .object({
            key: z.string().min(1).max(512),
            completedAt: z.string().datetime({ offset: true }),
            delivery: NotificationDeliveryStateSchema.optional(),
          })
          .strict(),
      ),
    })
    .strict();
}

export interface NotificationSend<TPayload> {
  readonly action?: string;
  readonly idempotencyKey?: string;
  readonly key: string;
  readonly payload: TPayload;
  readonly attempt: number;
}

export interface NotificationFailureClassification {
  readonly retryable: boolean;
  readonly recipientUnreachable?: boolean;
}

export interface DroppedNotification<TPayload> {
  readonly item: NotificationOutboxItem<TPayload>;
  readonly error: unknown;
  readonly reason: 'terminal' | 'recipient-unreachable' | 'attempt-limit';
}

export interface NotificationOutboxConfig<TPayload> {
  readonly store: StateStore<NotificationOutboxState<TPayload>>;
  readonly payloadSchema: z.ZodType<TPayload>;
  readonly send: (notification: NotificationSend<TPayload>) => unknown | Promise<unknown>;
  readonly delivery?: NotificationDeliveryConfig<TPayload>;
  readonly classify: (
    error: unknown,
  ) => NotificationFailureClassification | Promise<NotificationFailureClassification>;
  readonly clock?: () => Date;
  readonly ownerId?: string;
  readonly pollIntervalMs?: number;
  readonly leaseMs?: number;
  readonly maxAttempts?: number;
  readonly maxQueue?: number;
  readonly maxStateBytes?: number;
  readonly retainReceipts?: number;
  readonly backoffMs?: (attempt: number) => number;
  readonly onDropped?: (notification: DroppedNotification<TPayload>) => void | Promise<void>;
  readonly onError?: (error: unknown) => void | Promise<void>;
}

export interface EnqueueNotification<TPayload> {
  readonly key: string;
  readonly payload: TPayload;
  /** Pending keys made obsolete by this notification. */
  readonly supersedes?: readonly string[];
}

export interface NotificationOutbox<TPayload> {
  enqueue(input: EnqueueNotification<TPayload>): Promise<boolean>;
  /** Drain every notification due at the current clock reading. */
  flush(): Promise<number>;
  start(): void;
  stop(): Promise<void>;
  state(): Promise<NotificationOutboxState<TPayload>>;
}

const emptyOutboxState = <TPayload>(): NotificationOutboxState<TPayload> => ({
  schemaVersion: 1,
  queue: [],
  receipts: [],
});

/** A reporting failure must not stop the durable delivery loop. */
async function reportOutboxError<TPayload>(
  config: NotificationOutboxConfig<TPayload>,
  error: unknown,
): Promise<void> {
  try {
    await config.onError?.(error);
  } catch {
    // Swallowed on purpose: the loop outlives its observer.
  }
}

function notificationRejection<TPayload>(
  config: NotificationOutboxConfig<TPayload>,
  parse: (
    state: NotificationOutboxState<TPayload> | null,
  ) => NotificationOutboxState<TPayload>,
  bounded: (state: NotificationOutboxState<TPayload>) => NotificationOutboxState<TPayload>,
  clock: () => Date,
  backoffMs: (attempt: number) => number,
  pollIntervalMs: number,
) {
  const maxAttempts = config.maxAttempts ?? 100;
  return async (
    claimed: NotificationOutboxItem<TPayload>,
    error: unknown,
  ): Promise<DroppedNotification<TPayload> | null> => {
    // A plan this executor does not know is not a failed attempt: an executor
    // that knows it — the other side of a rolling deploy, or the version a
    // rollback returns to — will. It waits, attempts untouched, and is reported.
    const unknownPlan = error instanceof NotificationPlanVersionError;
    if (unknownPlan) await reportOutboxError(config, error);
    const classification: NotificationFailureClassification = unknownPlan
      ? { retryable: true }
      : await config.classify(error);
    return config.store.update((current) => {
      const state = parse(current);
      const live = state.queue.find(
        (item) => item.key === claimed.key && item.leaseId === claimed.leaseId,
      );
      if (!live) return { state, result: null };
      const attempts = unknownPlan ? Math.max(0, live.attempts - 1) : live.attempts;
      const reason = dropReason(classification, attempts, maxAttempts);
      if (reason) {
        return {
          state: bounded({
            ...state,
            queue: state.queue.filter((item) => item.key !== live.key),
          }),
          result: { item: { ...live, attempts }, error, reason },
        };
      }
      // An unknown plan spends no attempt, so nothing else bounds its retries:
      // it waits at least a poll interval, never within the same pass.
      const backoff = RetryDelaySchema.parse(backoffMs(Math.max(1, attempts)));
      const wait = unknownPlan ? Math.max(backoff, pollIntervalMs) : backoff;
      const retry: NotificationOutboxItem<TPayload> = {
        ...live,
        attempts,
        nextAttemptAt: new Date(clock().getTime() + wait).toISOString(),
        ...NO_LEASE,
      };
      return {
        state: bounded({
          ...state,
          queue: state.queue.map((item) => (item.key === live.key ? retry : item)),
        }),
        result: null,
      };
    });
  };
}

export function createNotificationOutbox<TPayload>(
  config: NotificationOutboxConfig<TPayload>,
): NotificationOutbox<TPayload> {
  const schema = notificationOutboxStateSchema(config.payloadSchema);
  const clock = config.clock ?? (() => new Date());
  const ownerId = config.ownerId ?? crypto.randomUUID();
  const { pollIntervalMs, leaseMs, maxQueue, maxStateBytes, retainReceipts } =
    resolveOutboxLimits(config);
  const backoffMs =
    config.backoffMs ?? ((attempt: number) => backoffDelay(DEFAULT_OUTBOX_BACKOFF, attempt));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  // Set by `stop()`: the pass in flight finishes the send it is in and claims
  // nothing more. A `send` without its own deadline still holds `stop()` for
  // the length of that one call — the transport owns that timeout.
  let interrupted = false;
  let flushTail: Promise<unknown> = Promise.resolve();

  const bounded = (input: NotificationOutboxState<TPayload>) =>
    boundedOutboxState(schema.parse(input), maxQueue, retainReceipts, maxStateBytes);

  const parse = (state: NotificationOutboxState<TPayload> | null) =>
    schema.parse(state ?? emptyOutboxState<TPayload>());

  const enqueue = async (input: EnqueueNotification<TPayload>): Promise<boolean> => {
    const key = z.string().min(1).max(512).parse(input.key);
    const payload = config.payloadSchema.parse(input.payload);
    const supersedes = new Set(input.supersedes ?? []);
    return config.store.update((current) => {
      const state = parse(current);
      if (
        state.queue.some((item) => item.key === key) ||
        state.receipts.some((receipt) => receipt.key === key)
      ) {
        return { state, result: false };
      }
      const now = clock().toISOString();
      const fresh = {
        key,
        payload,
        createdAt: now,
        attempts: 0,
        nextAttemptAt: now,
        ...(config.delivery && {
          delivery: notificationDeliveryPlan(config.delivery, payload),
        }),
      };
      const queue = [
        ...state.queue.filter((item) => !supersedes.has(item.key)),
        { ...fresh, ...NO_LEASE },
      ];
      const next = bounded({ ...state, queue });
      return { state: next, result: true };
    });
  };

  const claimNext = async (): Promise<NotificationOutboxItem<TPayload> | null> => {
    const now = clock();
    return config.store.update((current) => {
      const state = parse(current);
      const claimed = claimDue(state.queue, now, ownerId, leaseMs);
      if (!claimed) return { state, result: null };
      return {
        state: bounded({
          ...state,
          queue: state.queue.map((item) => (item.key === claimed.key ? claimed : item)),
        }),
        result: claimed,
      };
    });
  };

  const acknowledge = async (claimed: NotificationOutboxItem<TPayload>): Promise<void> => {
    await config.store.update((current) => {
      const state = parse(current);
      const live = state.queue.find(
        (item) => item.key === claimed.key && item.leaseId === claimed.leaseId,
      );
      if (!live) return { state, result: undefined };
      const receipts = [
        {
          key: claimed.key,
          completedAt: clock().toISOString(),
          ...(live.delivery && { delivery: live.delivery }),
        },
        ...state.receipts.filter((receipt) => receipt.key !== claimed.key),
      ].slice(0, retainReceipts);
      return {
        state: bounded({
          ...state,
          queue: state.queue.filter((item) => item.key !== claimed.key),
          receipts,
        }),
        result: undefined,
      };
    });
  };

  const reject = notificationRejection(
    config,
    parse,
    bounded,
    clock,
    backoffMs,
    pollIntervalMs,
  );

  const flushPass = async (): Promise<number> => {
    let delivered = 0;
    while (!interrupted) {
      const claimed = await claimNext();
      if (!claimed) return delivered;
      try {
        if (config.delivery) {
          const finished = await deliverNotification({
            item: claimed,
            store: config.store,
            config: config.delivery,
            send: config.send,
            clock,
            bounded,
            leaseMs,
            active: () => !interrupted,
            report: (error) => reportOutboxError(config, error),
          });
          if (!finished) return delivered;
        } else {
          if (claimed.delivery)
            throw new Error('An action-plan notification requires its delivery executor');
          await config.send({
            key: claimed.key,
            payload: claimed.payload,
            attempt: claimed.attempts,
          });
        }
        await acknowledge(claimed);
        delivered += 1;
      } catch (error) {
        const dropped = await reject(claimed, error);
        if (dropped) await config.onDropped?.(dropped);
      }
    }
    return delivered;
  };

  const flush = (): Promise<number> => {
    const result = flushTail.then(flushPass, flushPass);
    flushTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const runScheduled = async (): Promise<void> => {
    try {
      await flush();
    } catch (error) {
      await reportOutboxError(config, error);
    } finally {
      schedule();
    }
  };

  const schedule = (): void => {
    if (!running) return;
    timer = setTimeout(() => {
      void runScheduled();
    }, pollIntervalMs);
  };

  return {
    enqueue,
    flush,
    start() {
      if (running) return;
      running = true;
      interrupted = false;
      void runScheduled();
    },
    async stop() {
      running = false;
      interrupted = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      try {
        await flushTail;
      } finally {
        interrupted = false;
      }
    },
    async state() {
      // A read never fails on the bounds a transition enforces — an oversized
      // file is inspected here and trimmed by the next transition.
      return parse(await config.store.read());
    },
  };
}

export interface NotificationOutboxResourceConfig {
  readonly id?: string;
}

export interface NotificationOutboxResource<TPayload> extends ManagedResource {
  start(): { readonly value: NotificationOutbox<TPayload> };
}

export function notificationOutboxResource<TPayload>(
  outbox: NotificationOutbox<TPayload>,
  config: NotificationOutboxResourceConfig = {},
): NotificationOutboxResource<TPayload> {
  return defineManagedResource({
    id: config.id ?? 'notification-outbox',
    start() {
      outbox.start();
      return { value: outbox };
    },
    async close() {
      await outbox.stop();
    },
    async force() {
      await outbox.stop();
    },
  });
}
