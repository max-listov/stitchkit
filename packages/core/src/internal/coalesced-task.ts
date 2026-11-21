import { type BackoffPolicy, createBackoff } from './backoff';

export interface CoalescedTask {
  readonly running: boolean;
  /** A trigger arrived that no pass has served yet. */
  readonly pending: boolean;
  /** Milliseconds until the pass after a failure may start; `0` when nothing holds it. */
  readonly retryInMs: number;
  trigger(): void;
  pauseRetry(): void;
  close(): void;
}

/** What a pass that neither succeeded nor failed returns: its work was abandoned. */
export const ABANDONED_PASS = Symbol('abandoned pass');

/**
 * One job per key; hints during work become one trailing pass, failures retain retry.
 *
 * The pause after a failure belongs to the job, not to whoever is asking: a
 * paused retry keeps the moment it is due, and a trigger before that moment
 * waits for it instead of running at once. A pass that returns
 * {@link ABANDONED_PASS} stays dirty and leaves the failure count alone.
 */
export function createCoalescedTask(config: {
  /** Resolves with {@link ABANDONED_PASS} for abandoned work; any other value is a completed pass. */
  run(): Promise<unknown>;
  active(): boolean;
  onError(error: unknown): void;
  backoff: BackoffPolicy;
}): CoalescedTask {
  const backoff = createBackoff(config.backoff);
  let running = false;
  let dirty = false;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  /** When the pass after a failure may start; kept across `pauseRetry`. */
  let retryDueAt: number | undefined;
  const pauseRetry = () => {
    clearTimeout(retry);
    retry = undefined;
  };
  const scheduleRetry = (delayMs: number) => {
    retry = setTimeout(() => {
      retry = undefined;
      void pump();
    }, delayMs);
    retry.unref?.();
  };
  const pump = async () => {
    if (running || closed || !config.active() || retry) return;
    if (retryDueAt !== undefined) {
      const remaining = retryDueAt - performance.now();
      if (remaining > 0) {
        scheduleRetry(remaining);
        return;
      }
      retryDueAt = undefined;
    }
    running = true;
    try {
      while (dirty && !closed && config.active()) {
        dirty = false;
        try {
          if ((await config.run()) === ABANDONED_PASS) dirty = true;
          else backoff.reset();
        } catch (error) {
          dirty = true;
          const delayMs = backoff.next();
          retryDueAt = performance.now() + delayMs;
          if (!closed && config.active()) {
            scheduleRetry(delayMs);
            config.onError(error);
          }
          return;
        }
      }
    } finally {
      running = false;
    }
  };
  return {
    get running() {
      return running;
    },
    get pending() {
      return dirty;
    },
    get retryInMs() {
      return retryDueAt === undefined ? 0 : Math.max(0, retryDueAt - performance.now());
    },
    trigger() {
      if (closed) return;
      dirty = true;
      void pump();
    },
    pauseRetry,
    close() {
      closed = true;
      dirty = false;
      pauseRetry();
    },
  };
}
