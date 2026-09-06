import { z } from 'zod';
import { backoffDelay } from '../browser/resumable';
import { measureSize } from '../observability/sanitize';
import { defineManagedResource, type ManagedResource } from './resource';
import type { StateStore } from './state-store';

export interface NotificationOutboxItem<TPayload> {
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
          })
          .strict(),
      ),
    })
    .strict();
}

export interface NotificationSend<TPayload> {
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
  readonly send: (notification: NotificationSend<TPayload>) => void | Promise<void>;
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

const sizeOf = (value: unknown): number => measureSize(value).responseBytes;

/** One second doubling to a minute, no jitter — a single durable queue, not a fleet. */
const DEFAULT_OUTBOX_BACKOFF = { minDelayMs: 1_000, maxDelayMs: 60_000, jitter: 0 } as const;

export function createNotificationOutbox<TPayload>(
  config: NotificationOutboxConfig<TPayload>,
): NotificationOutbox<TPayload> {
  const schema = notificationOutboxStateSchema(config.payloadSchema);
  const clock = config.clock ?? (() => new Date());
  const ownerId = config.ownerId ?? crypto.randomUUID();
  const pollIntervalMs = z
    .number()
    .int()
    .min(10)
    .parse(config.pollIntervalMs ?? 1_000);
  const leaseMs = z
    .number()
    .int()
    .min(100)
    .parse(config.leaseMs ?? 30_000);
  // Under the default backoff the 99 waits between 100 attempts sum to
  // 1+2+4+8+16+32 s plus 93 × 60 s ≈ 94 minutes — a transport outage an owner
  // notification must outlive.
  const maxAttempts = z
    .number()
    .int()
    .min(1)
    .max(10_000)
    .parse(config.maxAttempts ?? 100);
  const maxQueue = z
    .number()
    .int()
    .min(1)
    .max(100_000)
    .parse(config.maxQueue ?? 1_000);
  const maxStateBytes = z
    .number()
    .int()
    .min(1_024)
    .parse(config.maxStateBytes ?? 1024 * 1024);
  const retainReceipts = z
    .number()
    .int()
    .min(0)
    .max(100_000)
    .parse(config.retainReceipts ?? 1_000);
  const backoffMs =
    config.backoffMs ?? ((attempt: number) => backoffDelay(DEFAULT_OUTBOX_BACKOFF, attempt));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  // Set by `stop()`: the pass in flight finishes the send it is in and claims
  // nothing more. A `send` without its own deadline still holds `stop()` for
  // the length of that one call — the transport owns that timeout.
  let interrupted = false;
  let flushTail: Promise<unknown> = Promise.resolve();

  const bounded = (
    input: NotificationOutboxState<TPayload>,
  ): NotificationOutboxState<TPayload> => {
    const parsed = schema.parse(input);
    if (parsed.queue.length > maxQueue) {
      throw new Error(`[stitchkit] notification outbox queue limit (${maxQueue}) exceeded`);
    }
    let receipts = parsed.receipts.slice(0, retainReceipts);
    let next: NotificationOutboxState<TPayload> = { ...parsed, receipts };
    while (sizeOf(next) > maxStateBytes && receipts.length > 0) {
      receipts = receipts.slice(0, -1);
      next = { ...parsed, receipts };
    }
    if (sizeOf(next) > maxStateBytes) {
      throw new Error(
        `[stitchkit] notification outbox state limit (${maxStateBytes} bytes) exceeded`,
      );
    }
    return next;
  };

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
      const queue = [
        ...state.queue.filter((item) => !supersedes.has(item.key)),
        {
          key,
          payload,
          createdAt: now,
          attempts: 0,
          nextAttemptAt: now,
          leaseOwner: null,
          leaseId: null,
          leaseUntil: null,
        },
      ];
      const next = bounded({ ...state, queue });
      return { state: next, result: true };
    });
  };

  const claimNext = async (): Promise<NotificationOutboxItem<TPayload> | null> => {
    const now = clock();
    return config.store.update((current) => {
      const state = parse(current);
      const candidate = [...state.queue]
        .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
        .find(
          (item) =>
            Date.parse(item.nextAttemptAt) <= now.getTime() &&
            (item.leaseUntil === null || Date.parse(item.leaseUntil) <= now.getTime()),
        );
      if (!candidate) return { state, result: null };
      const leaseId = crypto.randomUUID();
      const claimed: NotificationOutboxItem<TPayload> = {
        ...candidate,
        attempts: candidate.attempts + 1,
        leaseOwner: ownerId,
        leaseId,
        leaseUntil: new Date(now.getTime() + leaseMs).toISOString(),
      };
      return {
        state: bounded({
          ...state,
          queue: state.queue.map((item) => (item.key === candidate.key ? claimed : item)),
        }),
        result: claimed,
      };
    });
  };

  const acknowledge = async (claimed: NotificationOutboxItem<TPayload>): Promise<void> => {
    await config.store.update((current) => {
      const state = parse(current);
      const owns = state.queue.some(
        (item) => item.key === claimed.key && item.leaseId === claimed.leaseId,
      );
      if (!owns) return { state, result: undefined };
      const receipts = [
        { key: claimed.key, completedAt: clock().toISOString() },
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

  const reject = async (
    claimed: NotificationOutboxItem<TPayload>,
    error: unknown,
  ): Promise<DroppedNotification<TPayload> | null> => {
    const classification = await config.classify(error);
    return config.store.update((current) => {
      const state = parse(current);
      const live = state.queue.find(
        (item) => item.key === claimed.key && item.leaseId === claimed.leaseId,
      );
      if (!live) return { state, result: null };
      const attempts = live.attempts;
      const reason: DroppedNotification<TPayload>['reason'] | null =
        classification.recipientUnreachable === true
          ? 'recipient-unreachable'
          : !classification.retryable
            ? 'terminal'
            : attempts >= maxAttempts
              ? 'attempt-limit'
              : null;
      if (reason) {
        return {
          state: bounded({
            ...state,
            queue: state.queue.filter((item) => item.key !== live.key),
          }),
          result: { item: { ...live, attempts }, error, reason },
        };
      }
      const rawDelay = backoffMs(attempts);
      const wait = z
        .number()
        .finite()
        .nonnegative()
        .max(24 * 60 * 60 * 1_000)
        .parse(rawDelay);
      const retry: NotificationOutboxItem<TPayload> = {
        ...live,
        attempts,
        nextAttemptAt: new Date(clock().getTime() + wait).toISOString(),
        leaseOwner: null,
        leaseId: null,
        leaseUntil: null,
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

  const flushPass = async (): Promise<number> => {
    let delivered = 0;
    while (!interrupted) {
      const claimed = await claimNext();
      if (!claimed) return delivered;
      try {
        await config.send({
          key: claimed.key,
          payload: claimed.payload,
          attempt: claimed.attempts,
        });
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
      try {
        await config.onError?.(error);
      } catch {
        // A reporting failure must not stop the durable delivery loop.
      }
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
