import type { EventDecision, EventTopicDeclaration, EventUndecided } from '../live/events';

/**
 * A listener's return value.
 *
 * `emit` ignores it, `emitSerial` awaits it, and `decide` reads it as a vote.
 * One registry serves all three, so a listener is registered once no matter how
 * its topic is delivered — a second registration path per mode is a second bus.
 */
export type EventHandler<T = unknown> = (data: T) => unknown;

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
 *
 * Pass `topics` from `defineEvents` as well and the bus becomes a **closed**
 * registry that enforces each topic's declared delivery mode: an unknown topic
 * is refused, and so is delivering a topic by a verb its declaration did not
 * choose.
 */
export interface EventBus<M extends Record<string, unknown> = DefaultEventMap> {
  /**
   * Announce and continue. Listeners run concurrently, a failing one is
   * isolated, and nothing is awaited. Declared topics: `emit` mode only.
   */
  emit<K extends keyof M & string>(event: K, data: M[K]): void;
  /**
   * Run listeners one at a time in registration order and wait for all of them.
   * A listener that throws, rejects or outruns its declared
   * `listenerTimeoutMs` is reported to `onListenerError` and the next listener
   * still runs — the caller waits for the sequence, not for every listener to
   * succeed. Requires a declared `serial` topic.
   */
  emitSerial<K extends keyof M & string>(event: K, data: M[K]): Promise<void>;
  /**
   * Collect listeners' votes in registration order and stop at the first
   * `deny`. Requires a declared `decision` topic.
   *
   * Every way a listener can fail to produce a vote resolves to `deny`, and the
   * reason says which: a throw, a rejection, a timeout, or a return value that
   * is not a decision at all. This is the one asymmetry worth stating out loud
   * — for `emit` an isolated failure means "the others carry on", and for a vote
   * the same isolation would mean "counted as consent". A listener that was
   * asked and did not answer has not agreed.
   */
  decide<K extends keyof M & string>(event: K, data: M[K]): Promise<EventDecision>;
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
  /**
   * The declared topics, from `defineEvents(...).topics`.
   *
   * Supplying them closes the registry: an event not declared is refused rather
   * than delivered to nobody, which is the failure a string-keyed bus cannot
   * report — a publisher with a typo and a subscriber with the right name look
   * exactly like a quiet system. It also supplies `listenerTimeoutMs` and
   * `whenAllDefer`, so those are read from the declaration instead of repeated
   * at every call site where they could disagree.
   */
  topics?: Readonly<Record<string, EventTopicDeclaration>>;
}

function isDecision(value: unknown): value is EventDecision {
  if (typeof value !== 'object' || value === null) return false;
  const outcome = Reflect.get(value, 'outcome');
  if (outcome === 'allow' || outcome === 'defer') return true;
  return outcome === 'deny' && typeof Reflect.get(value, 'reason') === 'string';
}

/**
 * Resolve to `timeout` if the listener has not settled in time.
 *
 * The timer is always cleared: a bus dispatch must not be the reason a process
 * stays alive, and an uncleared timer on every announcement is exactly that.
 */
async function withDeadline(
  value: unknown,
  timeoutMs: number,
): Promise<{ settled: true; value: unknown } | { settled: false }> {
  if (!(value instanceof Promise)) return { settled: true, value };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<{ settled: false }>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), timeoutMs);
  });
  try {
    return await Promise.race([
      value.then((settledValue) => ({ settled: true as const, value: settledValue })),
      expiry,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createEventBus<M extends Record<string, unknown> = DefaultEventMap>(
  options: EventBusOptions = {},
): EventBus<M> {
  const subscriptions = new Map<string, Set<Subscription>>();
  const declared = options.topics;

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

  /**
   * The declaration for an event, refusing the verb the caller used when the
   * topic declared another one. Without declared topics only `emit` is
   * available: `serial` needs a deadline and `decision` needs an outcome for
   * "everybody deferred", and neither has a defensible default.
   */
  function declarationFor(event: string, verb: 'emit' | 'emitSerial' | 'decide') {
    if (declared === undefined) {
      if (verb === 'emit') return undefined;
      throw new Error(
        `[stitchkit] event bus: ${verb}("${event}") needs declared topics — pass \`topics\` from defineEvents. Its delivery deadline and undecided outcome come from the declaration, and neither has a default.`,
      );
    }
    const topic = Reflect.get(declared, event) as EventTopicDeclaration | undefined;
    if (topic === undefined) {
      throw new Error(
        `[stitchkit] event bus: "${event}" is not a declared topic. Declared: ${Object.keys(declared).join(', ') || '(none)'}.`,
      );
    }
    const expected = { emit: 'emit', serial: 'emitSerial', decision: 'decide' } as const;
    if (expected[topic.mode] !== verb) {
      throw new Error(
        `[stitchkit] event bus: "${event}" is declared with mode '${topic.mode}', so it is delivered with ${expected[topic.mode]}(), not ${verb}().`,
      );
    }
    return topic;
  }

  /**
   * The listeners to run, in registration order, snapshotted before dispatch.
   *
   * The order is snapshotted, but membership is not: the set stays
   * authoritative during the run, so a listener removed by an earlier listener
   * is skipped rather than called. A handler that has unsubscribed has said it
   * is no longer listening — and on a `decision` topic, being called anyway
   * means its vote still counts. A `once` subscription is removed at its turn
   * rather than up front, so the same liveness check covers both kinds.
   */
  function planned(event: string): { set: Set<Subscription>; subs: Subscription[] } {
    const set = subscriptions.get(event) ?? new Set<Subscription>();
    return { set, subs: [...set] };
  }

  function report(error: unknown, event: string): void {
    options.onListenerError?.(error, event);
  }

  return {
    emit<K extends keyof M & string>(event: K, data: M[K]) {
      declarationFor(event, 'emit');
      const { set, subs } = planned(event);
      for (const sub of subs) {
        if (!set.has(sub)) continue;
        if (sub.once) set.delete(sub);
        try {
          // A handler may be async — route a rejected promise to the error
          // hook too, not only a synchronous throw, so one listener never
          // breaks the bus yet its failure is still observable.
          const result = sub.fn(data);
          if (result instanceof Promise) result.catch((err: unknown) => report(err, event));
        } catch (err) {
          report(err, event);
        }
      }
    },

    async emitSerial<K extends keyof M & string>(event: K, data: M[K]) {
      const topic = declarationFor(event, 'emitSerial');
      const timeoutMs = topic?.listenerTimeoutMs ?? 0;
      const { set, subs } = planned(event);
      for (const sub of subs) {
        if (!set.has(sub)) continue;
        if (sub.once) set.delete(sub);
        try {
          const outcome = await withDeadline(sub.fn(data), timeoutMs);
          if (!outcome.settled) {
            report(new Error(`listener did not settle within ${timeoutMs}ms`), event);
          }
        } catch (err) {
          report(err, event);
        }
      }
    },

    async decide<K extends keyof M & string>(event: K, data: M[K]): Promise<EventDecision> {
      const topic = declarationFor(event, 'decide');
      const timeoutMs = topic?.listenerTimeoutMs ?? 0;
      // `declarationFor` has already refused a non-`decision` topic, and
      // `defineEvents` refuses a `decision` topic without `whenAllDefer`.
      const undecided: EventUndecided = topic?.whenAllDefer ?? 'deny';
      const { set, subs } = planned(event);
      let allowed = false;
      for (const sub of subs) {
        if (!set.has(sub)) continue;
        if (sub.once) set.delete(sub);
        let vote: EventDecision;
        try {
          const outcome = await withDeadline(sub.fn(data), timeoutMs);
          if (!outcome.settled) {
            vote = { outcome: 'deny', reason: `listener did not vote within ${timeoutMs}ms` };
          } else if (isDecision(outcome.value)) {
            vote = outcome.value;
          } else {
            vote = {
              outcome: 'deny',
              reason:
                'listener returned no decision — a decision listener returns { outcome: "allow" | "deny" | "defer" }',
            };
          }
        } catch (err) {
          vote = {
            outcome: 'deny',
            reason: err instanceof Error ? `listener threw: ${err.message}` : 'listener threw',
          };
        }
        if (vote.outcome === 'deny') {
          report(new Error(vote.reason), event);
          return vote;
        }
        if (vote.outcome === 'allow') allowed = true;
      }
      // One explicit `allow` settles it: `defer` means "not my call", so a
      // listener that deferred beside one that allowed has not disagreed with it.
      // The declared outcome is for the case nobody claimed — every listener
      // deferred, or there were none at all.
      if (allowed) return { outcome: 'allow' };
      return undecided === 'allow'
        ? { outcome: 'allow' }
        : { outcome: 'deny', reason: 'no listener claimed this event' };
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
