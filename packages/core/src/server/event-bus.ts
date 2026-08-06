export type EventHandler<T = unknown> = (data: T) => void | Promise<void>;

/** Default event map — untyped string-keyed events (ad-hoc buses). */
export type DefaultEventMap = Record<string, unknown>;

/**
 * In-process pub/sub bus.
 *
 * Pass an event map for full type safety — `emit`/`on`/`once`/`off` are then
 * typed per event:
 *
 * ```ts
 * const bus = createEventBus<{ 'user:created': { id: string } }>();
 * bus.emit('user:created', { id: '1' }); // typed
 * ```
 */
export interface EventBus<M extends Record<string, unknown> = DefaultEventMap> {
  emit<K extends keyof M & string>(event: K, data: M[K]): void;
  on<K extends keyof M & string>(event: K, handler: EventHandler<M[K]>): () => void;
  once<K extends keyof M & string>(event: K, handler: EventHandler<M[K]>): () => void;
  off<K extends keyof M & string>(event: K, handler: EventHandler<M[K]>): void;
  clear(): void;
}

/**
 * One subscription — the user's handler plus whether it auto-unsubscribes.
 * `once` is a flag, not a wrapper closure, so `off(event, handler)` can find a
 * `once`-registered handler by identity exactly like an `on`-registered one.
 */
interface Subscription {
  fn: EventHandler;
  once: boolean;
}

/** Options for `createEventBus`. */
export interface EventBusOptions {
  /**
   * Called when a listener throws or rejects. A bus listener's failure must
   * never break the bus, so it is caught — but without this hook it is also
   * invisible. Wire it to a logger to surface listener bugs.
   */
  onListenerError?: (error: unknown, event: string) => void;
}

export function createEventBus<M extends Record<string, unknown> = DefaultEventMap>(
  options: EventBusOptions = {},
): EventBus<M> {
  const subscriptions = new Map<string, Set<Subscription>>();

  function add(event: string, fn: EventHandler, once: boolean): () => void {
    let set = subscriptions.get(event);
    if (!set) {
      set = new Set();
      subscriptions.set(event, set);
    }
    const sub: Subscription = { fn, once };
    set.add(sub);
    return () => {
      set.delete(sub);
    };
  }

  return {
    emit<K extends keyof M & string>(event: K, data: M[K]) {
      const set = subscriptions.get(event);
      if (!set) return;
      // Snapshot — a `once` subscription is removed during iteration, and a
      // handler may itself subscribe/unsubscribe.
      for (const sub of [...set]) {
        if (sub.once) set.delete(sub);
        try {
          // A handler may be async — route a rejected promise to the error
          // hook too, not only a synchronous throw, so one listener never
          // breaks the bus yet its failure is still observable.
          const result = sub.fn(data);
          if (result instanceof Promise) {
            result.catch((err) => options.onListenerError?.(err, event));
          }
        } catch (err) {
          options.onListenerError?.(err, event);
        }
      }
    },

    on<K extends keyof M & string>(event: K, handler: EventHandler<M[K]>) {
      return add(event, handler as EventHandler, false);
    },

    once<K extends keyof M & string>(event: K, handler: EventHandler<M[K]>) {
      return add(event, handler as EventHandler, true);
    },

    off<K extends keyof M & string>(event: K, handler: EventHandler<M[K]>) {
      const set = subscriptions.get(event);
      if (!set) return;
      for (const sub of set) {
        if (sub.fn === handler) set.delete(sub);
      }
    },

    clear() {
      subscriptions.clear();
    },
  };
}
