/**
 * Typed Socket.IO client — the family WebSocket client.
 *
 * The whole family runs on Socket.IO (`polling` fallback, heartbeat, acks,
 * mature reconnection) — not a hand-rolled WebSocket. Every project copied the
 * same ~150-line client: `io()` config, connection-state machine, a typed
 * `on/emit`, a connection-change subscription. `createSocketIOClient` is that
 * shared kernel.
 *
 * Subscriptions are durable: `on()` registers a handler once and the client
 * re-attaches it onto every socket it builds — so a handler survives an
 * explicit `disconnect()` / `connect()` cycle, and (because re-attach happens
 * before `socket.connect()`) no handshake-time event is ever missed. A thin
 * per-project layer can therefore subscribe once at construction.
 *
 * Auth identity (`userId`, `clientId`) is project-specific — it arrives in an
 * app `authenticated` event — so it stays in that per-project layer on top.
 * This client owns only the transport: connection lifecycle + typed events.
 *
 * The returned client satisfies `CacheBridgeSocket` (`on()` returns an
 * unsubscribe), so it plugs straight into `createCacheBridge`.
 */
import type { EventsMap } from '@socket.io/component-emitter';
import { io } from 'socket.io-client';

/** The concrete Socket.IO client socket type (loose, default event typing). */
type ClientSocket = ReturnType<typeof io>;

/**
 * Adapt our friendly `auth` form to what `io()` expects. socket.io's function
 * form is callback-based (`(cb) => cb(payload)`) and called on every (re)connect;
 * we accept a plain sync/async producer and bridge it to that callback. If the
 * producer fails, send an empty auth object rather than leaving the handshake
 * waiting forever; a normal server-side auth gate will reject it. Object /
 * `undefined` pass straight through. No casts: socket.io types `auth` as
 * `{ [k]: any } | ((cb: (data: object) => void) => void)`.
 */
function toIoAuth(
  auth: SocketIOClientConfig['auth'],
): Record<string, unknown> | ((cb: (data: object) => void) => void) | undefined {
  if (typeof auth !== 'function') return auth;
  return (cb) => {
    void Promise.resolve()
      .then(auth)
      .then(cb, () => cb({}));
  };
}

/**
 * Socket.IO event map — `{ event: (...args) => void }`. Aliases Socket.IO's
 * own `EventsMap` constraint, which intentionally maps to `any`: that is what
 * lets a plain `interface ServerToClientEvents { … }` (no index signature) be
 * passed as a type argument. Per-event typing is fully preserved on the
 * public `on` / `emit` signatures.
 */
export type SocketEventMap = EventsMap;

export interface SocketIOClientConfig {
  /** Server origin, e.g. `https://api.example.com`. */
  url: string;
  /** Socket.IO endpoint path. Default `/socket.io/`. */
  path?: string;
  /** Send cookies on the handshake (cookie-based auth). Default `true`. */
  withCredentials?: boolean;
  /**
   * Handshake auth payload — token-based auth, the alternative to cookie auth
   * (`withCredentials`). Reaches the server as `socket.handshake.auth`. A
   * **function** is re-read on every (re)connect, so a rotated token is picked
   * up automatically — no need to recreate the client (and lose durable
   * subscriptions). The function may be async.
   */
  auth?:
    | Record<string, unknown>
    | (() => Record<string, unknown> | Promise<Record<string, unknown>>);
  /** Extra query params on the handshake URL — reaches `socket.handshake.query`. */
  query?: Record<string, string | number | boolean>;
  /**
   * Extra handshake headers. In a browser these apply to the **polling**
   * transport only — a WebSocket upgrade cannot set request headers, so for
   * browser WebSocket auth use `auth` instead. Useful from non-browser clients
   * (Node/Bun server-to-server) where headers are honoured on every transport.
   */
  extraHeaders?: Record<string, string>;
  /** Transports, in preference order. Default `['websocket', 'polling']`. */
  transports?: Array<'websocket' | 'polling'>;
  /** Reconnection attempts. Default `Infinity`. */
  reconnectionAttempts?: number;
  /** Initial reconnection delay (ms). Default `1000`. */
  reconnectionDelay?: number;
  /** Max reconnection delay (ms). Default `5000`. */
  reconnectionDelayMax?: number;
  /** Connection timeout (ms). Default `20000`. */
  timeout?: number;
}

export interface SocketIOClient<
  TServerEvents extends SocketEventMap,
  TClientEvents extends SocketEventMap,
> {
  /** Create the socket (if absent) and connect. Idempotent. */
  connect(): void;
  /** Disconnect and drop the socket instance. */
  disconnect(): void;
  /** True while the underlying socket is connected. */
  readonly connected: boolean;
  /**
   * Subscribe to a server → client event. Returns an unsubscribe. The handler
   * is durable — it is re-attached onto every socket the client builds, so it
   * survives a `disconnect()` / `connect()` cycle.
   */
  on<E extends keyof TServerEvents & string>(event: E, handler: TServerEvents[E]): () => void;
  /** Emit a client → server event. No-op while disconnected. */
  emit<E extends keyof TClientEvents & string>(
    event: E,
    ...args: Parameters<TClientEvents[E]>
  ): void;
  /** Subscribe to connection up/down changes. Returns an unsubscribe. */
  onConnectionChange(listener: (connected: boolean) => void): () => void;
}

export function createSocketIOClient<
  TServerEvents extends SocketEventMap,
  TClientEvents extends SocketEventMap,
>(config: SocketIOClientConfig): SocketIOClient<TServerEvents, TClientEvents> {
  // The internal socket keeps Socket.IO's default (loose) event typing — the
  // public methods below are the fully-typed surface. Socket.IO's emitter is a
  // conditional-typed API that cannot be forwarded through a generic wrapper;
  // the default-typed socket lets the delegation stay cast-free.
  let socket: ClientSocket | null = null;
  const connectionListeners = new Set<(connected: boolean) => void>();
  // Durable event subscriptions — each re-attaches itself onto a fresh socket.
  const subscriptions = new Set<(socket: ClientSocket) => void>();

  function notifyConnection(connected: boolean): void {
    for (const listener of connectionListeners) listener(connected);
  }

  return {
    get connected() {
      return socket?.connected ?? false;
    },

    connect() {
      if (socket) return;

      socket = io(config.url, {
        path: config.path ?? '/socket.io/',
        withCredentials: config.withCredentials ?? true,
        auth: toIoAuth(config.auth),
        ...(config.query && { query: config.query }),
        ...(config.extraHeaders && { extraHeaders: config.extraHeaders }),
        transports: config.transports ?? ['websocket', 'polling'],
        autoConnect: false,
        reconnection: true,
        reconnectionAttempts: config.reconnectionAttempts ?? Infinity,
        reconnectionDelay: config.reconnectionDelay ?? 1000,
        reconnectionDelayMax: config.reconnectionDelayMax ?? 5000,
        timeout: config.timeout ?? 20_000,
      });

      socket.on('connect', () => notifyConnection(true));
      socket.on('disconnect', () => notifyConnection(false));
      // Re-attach every registered handler BEFORE connecting — nothing emitted
      // during the handshake (e.g. an `authenticated` reply) can be missed.
      for (const attach of subscriptions) attach(socket);

      socket.connect();
    },

    disconnect() {
      if (!socket) return;
      const wasConnected = socket.connected;
      // Drop every listener before releasing the socket — otherwise the
      // `connect`/`disconnect`/handler closures leak with the orphaned instance.
      socket.removeAllListeners();
      socket.disconnect();
      socket = null;
      // Only report a transition if there was a live connection to lose.
      if (wasConnected) notifyConnection(false);
    },

    on(event, handler) {
      // Widen the event to a plain `string` — Socket.IO's `.on` listener type
      // is a conditional over the event name that a generic forward can't
      // resolve; `string` collapses it to the loose `EventsMap` listener,
      // which `handler` already satisfies. Plain assignment, not a cast.
      const name: string = event;
      const attach = (s: ClientSocket): void => {
        s.on(name, handler);
      };
      subscriptions.add(attach);
      if (socket) attach(socket);

      return () => {
        subscriptions.delete(attach);
        socket?.off(name, handler);
      };
    },

    emit(event, ...args) {
      if (!socket?.connected) return;
      const name: string = event;
      socket.emit(name, ...args);
    },

    onConnectionChange(listener) {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },
  };
}
