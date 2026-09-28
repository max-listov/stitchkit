import { z } from 'zod';
import { type BackoffPolicy, createBackoff } from '../internal/backoff';
import { createCoalescedTask } from '../internal/coalesced-task';
import { withDeadline } from '../internal/deadline';
import { defineManagedResource, type ManagedResourceContext } from './resource';

export interface ChangeConnection {
  subscribe(input: {
    signal: AbortSignal;
    hint(key: string): void;
    disconnected(error: unknown): void;
  }): Promise<void>;
  close(): void | Promise<void>;
}
export interface ChangeReconciliation {
  readonly signal: AbortSignal;
  /** Synchronous publication is admitted only for the connection that started the read. */
  commit(publish: () => void): boolean;
}
export interface ChangeSubscriptionConfig {
  readonly id: string;
  readonly keys: readonly string[];
  readonly connect: (signal: AbortSignal) => Promise<ChangeConnection>;
  readonly reconcile: (key: string, context: ChangeReconciliation) => Promise<void>;
  readonly reconcileIntervalMs: number;
  readonly timeoutMs?: number;
  readonly backoff?: BackoffPolicy;
  readonly onError: (error: unknown) => void;
}

/** Volatile hints wake durable reads; one subscription generation owns publication. */
class ChangeSubscription {
  readonly keys;
  readonly interval;
  readonly timeout;
  readonly backoff;
  readonly tasks;
  readonly failedKeys = new Set<string>();
  lifetime?: AbortController;
  attempt?: AbortController;
  connection?: ChangeConnection;
  opening?: Promise<void>;
  closing?: Promise<void>;
  retry?: ReturnType<typeof setTimeout>;
  periodic?: ReturnType<typeof setInterval>;
  context?: ManagedResourceContext;
  removeAbort?: () => void;

  constructor(readonly config: ChangeSubscriptionConfig) {
    this.keys = z.array(z.string().min(1).max(256)).min(1).max(128).parse(config.keys);
    if (new Set(this.keys).size !== this.keys.length)
      throw new Error('Subscription keys must be unique');
    this.interval = z.number().int().min(10).max(3_600_000).parse(config.reconcileIntervalMs);
    this.timeout = z
      .number()
      .int()
      .min(1)
      .max(3_600_000)
      .parse(config.timeoutMs ?? 30_000);
    const policy = config.backoff ?? { minDelayMs: 250, maxDelayMs: 30_000, jitter: 0.2 };
    this.backoff = createBackoff(policy);
    this.tasks = new Map(
      this.keys.map((key) => [
        key,
        createCoalescedTask({
          active: () =>
            this.connection !== undefined && this.attempt?.signal.aborted === false,
          run: () => this.read(key),
          onError: (error) => {
            this.failedKeys.add(key);
            this.report(error);
          },
          backoff: policy,
        }),
      ]),
    );
  }

  report(error: unknown): void {
    this.context?.reportHealth('degraded');
    try {
      this.config.onError(error);
    } catch {
      /* Observation does not own recovery. */
    }
  }

  async read(key: string): Promise<void> {
    const connection = this.connection;
    const attempt = this.attempt;
    if (!connection || !attempt) return;
    const readAbort = new AbortController();
    const signal = AbortSignal.any([attempt.signal, readAbort.signal]);
    const work = this.config.reconcile(key, {
      signal,
      commit: (publish) => {
        if (signal.aborted || this.connection !== connection) return false;
        publish();
        return true;
      },
    });
    const outcome = await withDeadline(work, this.timeout);
    if (!outcome.settled) {
      readAbort.abort();
      this.report(new Error('Reconciliation deadline exceeded'));
      // Retain the key until an uncooperative read settles: never overlap its next pass.
      await work;
      throw new Error('Reconciliation deadline exceeded');
    }
    if (!signal.aborted && this.connection === connection) {
      this.failedKeys.delete(key);
      if (this.failedKeys.size === 0) this.context?.reportHealth('healthy');
    }
  }

  reconcile(): void {
    for (const task of this.tasks.values()) task.trigger();
  }

  schedule(): void {
    if (!this.lifetime || this.lifetime.signal.aborted || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      void this.open();
    }, this.backoff.next());
    this.retry.unref?.();
  }

  async release(handle: ChangeConnection): Promise<void> {
    const work = Promise.resolve().then(() => handle.close());
    this.closing = work;
    try {
      const outcome = await withDeadline(work, this.timeout);
      if (!outcome.settled) {
        this.report(new Error('Subscription close deadline exceeded'));
        // No reconnect while the old transport may still be alive.
        await work;
      }
    } finally {
      if (this.closing === work) this.closing = undefined;
    }
  }

  lost(handle: ChangeConnection, error: unknown): void {
    if (this.connection !== handle) return;
    this.connection = undefined;
    this.attempt?.abort();
    this.report(error);
    // A close that failed is reported, not waited on forever: `release` has
    // already outlived any close still running, so the old transport is done
    // either way and the subscription must come back.
    void this.release(handle)
      .catch((cause: unknown) => this.report(cause))
      .then(() => this.schedule());
  }

  open(): Promise<void> {
    if (this.opening) return this.opening;
    const lifetime = this.lifetime;
    if (!lifetime || lifetime.signal.aborted || this.closing) return Promise.resolve();
    this.opening = this.connect(lifetime).finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  async connect(lifetime: AbortController): Promise<void> {
    const attempt = new AbortController();
    this.attempt = attempt;
    const onAbort = () => attempt.abort();
    lifetime.signal.addEventListener('abort', onAbort, { once: true });
    let handle: ChangeConnection | undefined;
    let lost = false;
    const work = (async () => {
      handle = await this.config.connect(attempt.signal);
      if (attempt.signal.aborted) return;
      const owned = handle;
      await owned.subscribe({
        signal: attempt.signal,
        hint: (key) => {
          if (attempt.signal.aborted || lost) return;
          const task = this.tasks.get(key);
          if (task) task.trigger();
          else this.report(new Error('Unknown subscription key'));
        },
        disconnected: (error) => {
          if (attempt.signal.aborted || this.lifetime !== lifetime) return;
          lost = true;
          if (this.connection === owned) this.lost(owned, error);
          else this.report(error);
        },
      });
    })();
    try {
      const outcome = await withDeadline(work, this.timeout);
      if (!outcome.settled) {
        attempt.abort();
        this.report(new Error('Subscription connect deadline exceeded'));
        await work;
      }
      if (attempt.signal.aborted || lifetime !== this.lifetime || lost) {
        if (handle) await this.release(handle);
        this.schedule();
        return;
      }
      this.connection = handle;
      this.backoff.reset();
      this.context?.reportHealth('healthy');
      this.reconcile();
    } catch (error) {
      attempt.abort();
      if (handle) {
        try {
          await this.release(handle);
        } catch (cause) {
          this.report(cause);
        }
      }
      if (!lifetime.signal.aborted) {
        this.report(error);
        this.schedule();
      }
    } finally {
      lifetime.signal.removeEventListener('abort', onAbort);
    }
  }

  start(context: ManagedResourceContext) {
    if (this.lifetime && !this.lifetime.signal.aborted)
      throw new Error('Subscription already started');
    if (this.opening || this.closing || [...this.tasks.values()].some((task) => task.running))
      throw new Error('Previous subscription work has not settled');
    this.context = context;
    this.lifetime = new AbortController();
    const abort = () => {
      void this.close();
    };
    context.signal.addEventListener('abort', abort, { once: true });
    this.removeAbort = () => context.signal.removeEventListener('abort', abort);
    if (context.signal.aborted) {
      void this.close();
      return {};
    }
    this.periodic = setInterval(() => this.reconcile(), this.interval);
    this.periodic.unref?.();
    // The kernel's startup budget bounds readiness as well as this adapter's own deadline.
    const ready = (async () => {
      const outcome = await withDeadline(this.open(), this.timeout);
      if (!outcome.settled || !this.connection) {
        void this.close().catch((error) => this.report(error));
        throw new Error('Subscription did not become ready before its deadline');
      }
    })();
    return { ready };
  }

  async close(): Promise<void> {
    this.lifetime?.abort();
    this.attempt?.abort();
    this.removeAbort?.();
    clearTimeout(this.retry);
    this.retry = undefined;
    clearInterval(this.periodic);
    this.periodic = undefined;
    for (const task of this.tasks.values()) task.pauseRetry();
    const handle = this.connection;
    this.connection = undefined;
    if (handle) {
      const outcome = await withDeadline(this.release(handle), this.timeout);
      if (!outcome.settled) this.report(new Error('Subscription shutdown deadline exceeded'));
    }
  }
}

export function changeSubscriptionResource(config: ChangeSubscriptionConfig) {
  const subscription = new ChangeSubscription(config);
  return defineManagedResource({
    id: config.id,
    start: (context) => subscription.start(context),
    close: () => subscription.close(),
    force: () => subscription.close(),
  });
}
