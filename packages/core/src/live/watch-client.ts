import type { SessionOperation } from '../browser/session';
/**
 * The client half of a watched read.
 *
 * `watch.notes.list({ folder: 'a' })` returns a handle. Subscribe to it and the
 * values arrive; unsubscribe and, once nobody is left, the server is told to
 * stop reading. Two components asking the same question share one subscription
 * and one server-side read, which is the arrangement the hub exists for and
 * which a per-component `useEffect` cannot reach.
 *
 * ## Why it is built from the contract, not from a method
 *
 * `watch(api.notes.list, args)` is the shape one would write first, and it
 * cannot work: a client method is a bare closure with a `withOptions` property
 * and no identity on it, deliberately — it has to survive being handed to a
 * `map`. Passing one here gives an anonymous function, and the server needs to
 * know *what* to re-read. So the watch client is built from the contract, like
 * `createUrlBuilder`, and the identity is the contract's own
 * `(prefix, endpoint key)` — the same pair the server labels every request with.
 *
 * ## A connection is not forever, and recovering is this client's job
 *
 * A socket drops and comes back, and the hub forgets everything the old
 * connection held — it releases a subscriber's keys the moment that subscriber
 * detaches. So a client that opened each question once and never again is a
 * client whose face freezes the first time a server restarts, *silently*,
 * because nothing tells the subscriber that what it is looking at stopped being
 * live.
 *
 * This client holds every key and every listener, so nobody else can do it: on a
 * drop it tells subscribers the source is gone and forgets that anything was
 * opened; on a fresh connection it re-opens every key that still has a listener.
 * That is why {@link WatchTransport} **requires** `onConnectionChange` rather
 * than using it when offered — a transport that cannot say when it reconnected
 * cannot host a recovering client, and an optional hook would turn recovery into
 * something that silently did not happen.
 *
 * ## Retention
 *
 * The last value of a key is kept while anyone holds it, and for `holdMs` after
 * the last subscriber leaves. A component that unmounts and remounts inside that
 * window paints immediately from memory. The key digest is cached too, so the
 * second subscription resolves synchronously — computing it is a promise, and a
 * value that arrives on a later microtask is not "before the network" in any
 * sense a rendering component can use.
 */
import type { ContractDef, EndpointDef } from '../contract/define';
import { argumentsDigest } from '../internal/stable-digest';
import {
  applyWatchFrame,
  openWatch,
  publishState,
  type WatchClientEntry,
} from './watch-client-state';
import {
  WATCH_CLOSE,
  type WATCH_OPEN,
  WATCH_STATE,
  WATCH_VALUE,
  type WatchHave,
  type WatchKey,
  type WatchStateFrame,
  type WatchValueFrame,
  watchKeyString,
} from './watch-contract';

export interface WatchListeners<TValue> {
  value(value: TValue): void;
  /** Phase and, when unhealthy, the read's own code and message. */
  state?(state: WatchStateFrame): void;
}

export interface WatchHandle<TValue> {
  /** Returns the unsubscribe. The retained value, if any, arrives before it returns. */
  subscribe(listeners: WatchListeners<TValue>): () => void;
  /** Drops every listener this handle registered and releases the key. */
  close(): void;
}

/** What the server sends a watcher, by event name. */
export interface WatchInboundEvents {
  [WATCH_VALUE]: WatchValueFrame;
  [WATCH_STATE]: WatchStateFrame;
}

/**
 * A realtime client, as much of one as this adapter needs to see.
 *
 * Four members and no types on them, because the point of this shape is that a
 * *typed* client satisfies it: a bound realtime client's `on` is generic over
 * the events of the contract it was bound to, and TypeScript will not relate
 * that signature to any concrete one written here — measured, both with a payload
 * parameter and with the tuple form the realtime handler actually has.
 */
export interface RealtimeClientLike {
  on: (...args: never[]) => unknown;
  emit: (...args: never[]) => unknown;
  request: (...args: never[]) => unknown;
  onConnectionChange: (...args: never[]) => unknown;
}

/**
 * Hand a bound realtime client to {@link createWatchClient}.
 *
 * The guide used to say "pass a bound realtime client" and the types refused it,
 * which is the worst combination: an instruction that reads as supported and
 * fails at the call site. This is the conversion, once, in the framework —
 * rather than the same cast copied into every application that follows the
 * guide.
 */
export function watchTransport(client: RealtimeClientLike): WatchTransport {
  // The one boundary cast this module makes, and the reason is above: two
  // generic signatures TypeScript declines to relate, over a client whose
  // runtime shape is exactly what `WatchTransport` describes. → ADR 0003.
  return client as unknown as WatchTransport;
}

/**
 * The transport half a watch client needs — a realtime client bound to a
 * contract that carries `watchContract`.
 *
 * Written in the protocol's own four event names rather than in `string`, so an
 * application bringing its own transport knows exactly what to implement.
 *
 * A **bound realtime client does not satisfy this shape**, and no phrasing of it
 * would fix that: its `on` is generic over the events of the contract it was
 * bound to, and TypeScript will not relate two generic signatures like these.
 * Pass it through {@link watchTransport}, which is that conversion done once
 * here instead of once per application.
 */
export interface WatchTransport {
  on<TEvent extends keyof WatchInboundEvents>(
    event: TEvent,
    handler: (payload: WatchInboundEvents[TEvent]) => void,
  ): () => void;
  emit(event: typeof WATCH_CLOSE, payload: { key: WatchKey }): unknown;
  request(
    event: typeof WATCH_OPEN,
    payload: { key: WatchKey; args: unknown; have?: WatchHave },
    options: { timeoutMs: number },
  ): Promise<{ accepted: boolean; reason?: string }>;
  /**
   * Observe connection changes. Required, because recovery depends on it.
   *
   * The hub releases a subscriber's keys when its connection detaches, so every
   * question opened over the old socket is gone the moment it drops. Without
   * this the client would go on believing it was subscribed and show a face that
   * had quietly stopped updating.
   */
  onConnectionChange(listener: (connected: boolean, reason?: string) => void): () => void;
}

export interface WatchClientConfig {
  readonly session?: SessionOperation<unknown>;
  readonly maxKeys?: number;
  readonly maxListenersPerKey?: number;
  readonly transport: WatchTransport;
  /** How long a key's value is retained after its last subscriber. Default 0. */
  readonly holdMs?: number;
  /** Deadline for the `open` acknowledgement. Default 10000. */
  readonly openTimeoutMs?: number;
  /** Called when the server refuses to open a watch, in its own words. */
  readonly onRefused?: (key: WatchKey, reason: string) => void;
}

export type TypedWatchClient<T extends Record<string, EndpointDef>> = {
  [K in keyof T]: (args?: Record<string, unknown>) => WatchHandle<unknown>;
};

export function createWatchClient<T extends Record<string, EndpointDef>>(
  contract: ContractDef<T, string>,
  config: WatchClientConfig,
): TypedWatchClient<T> {
  const entries = new Map<string, WatchClientEntry>();
  const valid = () => !config.session || config.session.current();
  const maxKeys = config.maxKeys ?? 1024;
  const maxListeners = config.maxListenersPerKey ?? 128;
  for (const bound of [maxKeys, maxListeners])
    if (!Number.isInteger(bound) || bound < 1)
      throw new RangeError('Watch capacity must be positive');
  const holdMs = config.holdMs ?? 0;
  const openTimeoutMs = config.openTimeoutMs ?? 10_000;
  const service = contract.meta.prefix;

  /**
   * Start this one key over.
   *
   * Only this key: a difference that will not apply says nothing about the other
   * questions on the same socket, and tearing down the connection to fix one
   * stale list would take every other panel down with it. The held value is
   * dropped first, so the re-open offers nothing and is answered with the whole
   * value.
   *
   * The phase is `resync-required` and it is published rather than hidden —
   * this is a real event in the life of a watched read, and a client that
   * repaired itself in silence would make a recurring failure invisible.
   */
  function resynchronise(entry: WatchClientEntry, message: string): void {
    entry.hasValue = false;
    entry.value = undefined;
    entry.revision = 0;
    entry.fingerprint = undefined;
    entry.opened = false;
    publishState(entry, { key: entry.key, phase: 'resync-required', message });
    config.transport.emit(WATCH_CLOSE, { key: entry.key });
    void openWatch(config, openTimeoutMs, entry);
  }

  const offValue = config.transport.on(WATCH_VALUE, (frame) => {
    if (!valid()) return;
    const entry = entries.get(watchKeyString(frame.key));
    if (!entry) return;
    const outcome = applyWatchFrame(entry, frame);
    if (outcome.kind === 'resync') {
      resynchronise(entry, outcome.message);
      return;
    }
    if (outcome.kind !== 'value') return;
    for (const listener of [...entry.listeners]) listener.value(outcome.value);
  });

  const offState = config.transport.on(WATCH_STATE, (frame) => {
    if (!valid()) return;
    const entry = entries.get(watchKeyString(frame.key));
    if (!entry) return;
    publishState(entry, frame);
  });

  const offConnection = config.transport.onConnectionChange((connected, reason) => {
    if (!valid()) return;
    if (!connected) {
      // The hub let go of every key that connection held. Say so — a face that
      // stops updating without a word is the failure this exists to end — and
      // forget that anything was opened, so the next connection re-opens it.
      for (const entry of entries.values()) {
        entry.opened = false;
        entry.epoch += 1;
        publishState(entry, {
          key: entry.key,
          phase: 'unavailable',
          reason: 'source-unavailable',
          ...(reason !== undefined && { message: reason }),
        });
      }
      return;
    }
    for (const entry of entries.values()) {
      if (entry.listeners.size === 0) continue;
      publishState(entry, { key: entry.key, phase: 'opening' });
      void openWatch(config, openTimeoutMs, entry);
    }
  });

  const shutdown = () => {
    offValue();
    offState();
    offConnection();
    for (const entry of entries.values()) {
      entry.released = true;
      entry.epoch++;
      clearTimeout(entry.release);
      entry.listeners.clear();
      entry.value = undefined;
      entry.hasValue = false;
      config.transport.emit(WATCH_CLOSE, { key: entry.key });
    }
    entries.clear();
  };
  if (config.session?.signal.aborted) shutdown();
  else config.session?.signal.addEventListener('abort', shutdown, { once: true });

  function entryFor(key: WatchKey, args: Record<string, unknown>): WatchClientEntry {
    const id = watchKeyString(key);
    const existing = entries.get(id);
    if (existing) {
      clearTimeout(existing.release);
      existing.release = undefined;
      return existing;
    }
    if (entries.size >= maxKeys) throw new Error('Watch key capacity exceeded');
    const entry: WatchClientEntry = {
      epoch: 0,
      released: false,
      key,
      args,
      listeners: new Set(),
      revision: 0,
      hasValue: false,
      opened: false,
      answered: false,
      state: { key, phase: 'opening' },
    };
    entries.set(id, entry);
    return entry;
  }

  function releaseWatchClientEntry(entry: WatchClientEntry): void {
    if (entry.listeners.size > 0) return;
    const drop = () => {
      if (entry.listeners.size > 0) return;
      entry.released = true;
      entry.epoch++;
      entries.delete(watchKeyString(entry.key));
      config.transport.emit(WATCH_CLOSE, { key: entry.key });
    };
    if (holdMs === 0) {
      drop();
      return;
    }
    entry.release = setTimeout(drop, holdMs);
    entry.release.unref?.();
  }

  function handleFor(action: string, args: Record<string, unknown>): WatchHandle<unknown> {
    const mine = new Set<WatchListeners<unknown>>();
    // The key is computed here and now. It used to be a promise, which made the
    // first subscription of a question asynchronous and forced a cache beside it
    // so that at least the *second* one could hand back a retained value in the
    // same turn. A synchronous digest removes the promise, the cache, and the
    // difference between the first subscription and every later one.
    let entry = entryFor(
      {
        service,
        action,
        digest: argumentsDigest(args),
        ...(config.session && { instance: config.session.id }),
      },
      args,
    );

    return {
      subscribe(listeners) {
        config.session?.assertCurrent();
        if (entry.released) entry = entryFor(entry.key, args);
        if (entry.listeners.size >= maxListeners)
          throw new Error('Watch listener capacity exceeded');
        const registered = listeners as WatchListeners<unknown>;
        mine.add(registered);
        entry.listeners.add(registered);
        // Retained value first, state second: a subscriber that receives `live`
        // before the value it describes has been told the wrong thing for one
        // turn.
        if (entry.hasValue) registered.value(entry.value);
        registered.state?.(entry.state);
        void openWatch(config, openTimeoutMs, entry);
        return () => {
          mine.delete(registered);
          entry.listeners.delete(registered);
          releaseWatchClientEntry(entry);
        };
      },
      close() {
        for (const listener of mine) entry.listeners.delete(listener);
        mine.clear();
        releaseWatchClientEntry(entry);
      },
    };
  }

  const client: Record<string, (args?: Record<string, unknown>) => WatchHandle<unknown>> = {};
  for (const action of Object.keys(contract.endpoints)) {
    client[action] = (args = {}) => handleFor(action, args);
  }
  // The loose→typed bridge every generated client surface crosses: the methods
  // are built by walking the contract, so their per-endpoint types cannot be
  // expressed while building them. → ADR 0003.
  return client as unknown as TypedWatchClient<T>;
}
