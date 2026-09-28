import { type BackoffPolicy, createBackoff } from './backoff';

export interface CoalescedTask {
  readonly running: boolean;
  trigger(): void;
  pauseRetry(): void;
  close(): void;
}

/** One job per key; hints during work become one trailing pass, failures retain retry. */
export function createCoalescedTask(config: {
  run(): Promise<void>;
  active(): boolean;
  onError(error: unknown): void;
  backoff: BackoffPolicy;
}): CoalescedTask {
  const backoff = createBackoff(config.backoff);
  let running = false;
  let dirty = false;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const pauseRetry = () => {
    clearTimeout(retry);
    retry = undefined;
  };
  const pump = async () => {
    if (running || closed || !config.active() || retry) return;
    running = true;
    try {
      while (dirty && !closed && config.active()) {
        dirty = false;
        try {
          await config.run();
          backoff.reset();
        } catch (error) {
          dirty = true;
          if (!closed && config.active()) {
            retry = setTimeout(() => {
              retry = undefined;
              void pump();
            }, backoff.next());
            retry.unref?.();
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
