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
}

export interface CacheBridge {
  connect(): void;
  disconnect(): void;
  /** Mark a query key as just-mutated. Call from a mutation's onSuccess so
   *  handlers can skip a stale socket echo via `ctx.isFresh()`. */
  markFresh(key: QueryKey): void;
}

export function createCacheBridge<TEvents>(config: CacheBridgeConfig<TEvents>): CacheBridge {
  const freshWindow = config.freshWindow ?? 500;
  const freshAt = new Map<string, number>();
  let unsubscribers: Array<() => void> = [];

  const isFresh = (key: QueryKey): boolean => {
    const ts = freshAt.get(JSON.stringify(key));
    return ts !== undefined && Date.now() - ts < freshWindow;
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
    },

    markFresh(key: QueryKey) {
      freshAt.set(JSON.stringify(key), Date.now());
    },
  };
}
