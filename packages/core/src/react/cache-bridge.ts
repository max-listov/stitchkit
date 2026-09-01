/**
 * Cache bridge — wire socket events into the TanStack Query cache.
 *
 * Transport-agnostic: works with ANY emitter exposing `on(event, handler) =>
 * unsubscribe` — socket.io, stitchkit's `SocketClient`, an `EventTarget`
 * wrapper. `TEvents` is a socket.io-style event map (`{ event: (payload) =>
 * void }`, i.e. `ServerToClientEvents`) — so the whole family (all on
 * socket.io) shares one cache-sync helper.
 *
 * Each handler updates `queryClient` in response to a typed server event.
 * `markFresh(key)` (called from a mutation's onSuccess) records a key as
 * just-mutated; a handler calls `ctx.isFresh(key)` to skip a stale socket echo
 * and avoid a double update (mutation result + socket event).
 */

import type { QueryClient, QueryKey } from '@tanstack/react-query';

/** Minimal emitter — subscribe to an event, get an unsubscribe back. */
import type { InferRealtimeEventMap, RealtimeEventRegistry } from '../realtime/contract';
import type { ValidatedRealtimeSocket } from '../realtime/socket';

export interface CacheBridgeSocket<TEvents> {
  on<K extends keyof TEvents & string>(event: K, handler: TEvents[K]): () => void;
}

export interface CacheBridgeContext {
  queryClient: QueryClient;
  /** True if `markFresh(key)` was called for this key within `freshWindow` ms. */
  isFresh(key: QueryKey): boolean;
}

/** Payload of a socket.io-style event entry `(payload) => void`. */
type EventPayload<T> = T extends (payload: infer P) => unknown ? P : never;

export type CacheBridgeHandler<TPayload> = (data: TPayload, ctx: CacheBridgeContext) => void;

export type CacheBridgeHandlers<TEvents> = {
  [K in keyof TEvents & string]?: CacheBridgeHandler<EventPayload<TEvents[K]>>;
};

export interface CacheBridgeConfig<TEvents> {
  socket: CacheBridgeSocket<TEvents>;
  /**
   * The TanStack Query client, or a thunk returning it. A thunk is resolved
   * lazily at `connect()` time — keeps the bridge SSR-safe when it lives in a
   * module-level `const` (client components are still evaluated on the server,
   * where a browser-only `QueryClient` does not exist yet).
   */
  queryClient: QueryClient | (() => QueryClient);
  handlers: CacheBridgeHandlers<TEvents>;
  /** Window (ms) after `markFresh()` during which `isFresh()` returns true. Default 500. */
  freshWindow?: number;
  /** Maximum remembered freshness keys. Oldest entries are evicted first. Default 1,000. */
  maxFreshKeys?: number;
}

export interface CacheBridge {
  connect(): void;
  disconnect(): void;
  /** Mark a query key as just-mutated. Call from a mutation's onSuccess so
   *  handlers can skip a stale socket echo via `ctx.isFresh()`. */
  markFresh(key: QueryKey): void;
  /** Forget every freshness marker without changing socket subscriptions. */
  clearFresh(): void;
}

/**
 * The bridge, fed by a validated realtime contract instead of a raw socket.
 *
 * A realtime registry maps an event name to its DEFINITION — `{ args, ack }` — while the bridge's
 * event map wants the handler FUNCTION at that position. Structurally the socket still matched,
 * so the generic bound to the registry and every payload inferred as `never`: the combination
 * `AGENTS.md` prescribes did not compile, and the error pointed at the consumer's own property
 * access rather than at the seam. Naming the mapping is the whole fix; nothing runs differently.
 */
export interface RealtimeCacheBridgeConfig<TInbound extends RealtimeEventRegistry>
  extends Omit<CacheBridgeConfig<InferRealtimeEventMap<TInbound>>, 'socket'> {
  socket: ValidatedRealtimeSocket<TInbound, RealtimeEventRegistry>;
}

export function createCacheBridge<TEvents>(config: CacheBridgeConfig<TEvents>): CacheBridge {
  const freshWindow = config.freshWindow ?? 500;
  const maxFreshKeys = config.maxFreshKeys ?? 1_000;
  if (!Number.isFinite(freshWindow) || freshWindow < 0) {
    throw new Error('cacheBridge.freshWindow must be a non-negative finite number');
  }
  if (!Number.isInteger(maxFreshKeys) || maxFreshKeys < 1) {
    throw new Error('cacheBridge.maxFreshKeys must be a positive integer');
  }
  const freshAt = new Map<string, number>();
  const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let unsubscribers: Array<() => void> = [];

  const isFresh = (key: QueryKey): boolean => {
    const serialised = JSON.stringify(key);
    const ts = freshAt.get(serialised);
    if (ts === undefined) return false;
    if (Date.now() - ts < freshWindow) return true;
    freshAt.delete(serialised);
    return false;
  };

  const clearFresh = (): void => {
    for (const timer of expiryTimers.values()) clearTimeout(timer);
    expiryTimers.clear();
    freshAt.clear();
  };

  return {
    connect() {
      if (unsubscribers.length > 0) return;
      // queryClient resolved lazily — a thunk is called here (browser, from an
      // effect), never at module evaluation → the bridge is SSR-safe as a const.
      const queryClient =
        typeof config.queryClient === 'function' ? config.queryClient() : config.queryClient;
      const ctx: CacheBridgeContext = { queryClient, isFresh };
      // Adapter boundary: iterating the handlers map erases the key↔payload
      // correlation. These casts bridge the typed config to the emitter's
      // loose per-event subscribe — sound at runtime (each handler is invoked
      // with exactly its own event's payload).
      const handlers = config.handlers as Record<
        string,
        CacheBridgeHandler<unknown> | undefined
      >;
      const socket = config.socket as CacheBridgeSocket<
        Record<string, (data: unknown) => void>
      >;
      for (const event of Object.keys(handlers)) {
        const handler = handlers[event];
        if (!handler) continue;
        const off = socket.on(event, (data: unknown) => handler(data, ctx));
        unsubscribers.push(off);
      }
    },

    disconnect() {
      for (const off of unsubscribers) off();
      unsubscribers = [];
      clearFresh();
    },

    markFresh(key: QueryKey) {
      const serialised = JSON.stringify(key);
      const existingTimer = expiryTimers.get(serialised);
      if (existingTimer) clearTimeout(existingTimer);
      freshAt.delete(serialised);
      freshAt.set(serialised, Date.now());
      expiryTimers.set(
        serialised,
        setTimeout(() => {
          freshAt.delete(serialised);
          expiryTimers.delete(serialised);
        }, freshWindow),
      );
      while (freshAt.size > maxFreshKeys) {
        const oldest = freshAt.keys().next().value;
        if (oldest === undefined) break;
        freshAt.delete(oldest);
        const timer = expiryTimers.get(oldest);
        if (timer) clearTimeout(timer);
        expiryTimers.delete(oldest);
      }
    },

    clearFresh,
  };
}

/**
 * The same bridge, fed by a validated realtime contract instead of a raw socket.
 *
 * A separate function rather than an overload, deliberately. A validated socket also satisfies
 * the looser `CacheBridgeSocket`, so an overload would be decided structurally — and worse, an
 * existing caller that passes its event map explicitly (`createCacheBridge<NoteEvents>(…)`) would
 * bind to whichever signature came first and stop compiling. Two names cost one line at the call
 * site and break nobody.
 */
export function createRealtimeCacheBridge<TInbound extends RealtimeEventRegistry>(
  config: RealtimeCacheBridgeConfig<TInbound>,
): CacheBridge {
  // No cast: `ValidatedRealtimeSocket.on` already takes `RealtimeEventHandler<TInbound[K]>`,
  // which is exactly what `InferRealtimeEventMap` puts at that key. The old failure was that
  // nothing ever performed this mapping, so the generic bound to the registry itself.
  return createCacheBridge<InferRealtimeEventMap<TInbound>>(config);
}
