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
import type {
  RealtimeContract,
  RealtimeEventRegistry,
  RealtimeRejectedEventHook,
} from '../realtime/contract';
import {
  createValidatedRealtimeSocket,
  type ValidatedRealtimeSocket,
} from '../realtime/socket';
import { createRetainedTopics } from '../retained';

// `socket.io-client` is loaded lazily (see `loadIo`) so it stays OUT of the
// root `stitchkit` entry's eager graph — importing `defineContract` must not
// drag the Socket.IO client into a bundle that never opens a socket. The type
// is pulled via a type-only `import(...)` query, which is fully erased.
type IoFn = typeof import('socket.io-client')['io'];

/** The concrete Socket.IO client socket type (loose, default event typing). */
type ClientSocket = ReturnType<IoFn>;

// Held in a variable, not a string literal, on purpose: under `--target node`
// the bundler rewrites a *literal* external dynamic import into a `createRequire`
// shim, which drags `node:module` into the browser graph (caught by
// `check-browser-clean`). A non-literal specifier stays a native `import()`.
const SOCKET_IO_CLIENT = 'socket.io-client';

// The peer module, loaded once and shared by every client. Failure clears the
// cache so a later `connect()` can retry, and reports the missing peer clearly
// (the same courtesy `stitchkit/server` gives for its Socket.IO server peer).
let ioLoader: Promise<IoFn> | null = null;
function loadIo(): Promise<IoFn> {
  if (!ioLoader) {
    ioLoader = import(SOCKET_IO_CLIENT).then(
      (mod: typeof import('socket.io-client')) => mod.io,
      (cause) => {
        ioLoader = null;
        throw new Error(
          'stitchkit: createSocketIOClient needs the "socket.io-client" peer — install it (e.g. `bun add socket.io-client`).',
          { cause },
        );
      },
    );
  }
  return ioLoader;
}

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

export interface SocketIOClientConfig<TServerEvents extends SocketEventMap = SocketEventMap> {
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
  /**
   * Survive a **server-initiated** disconnect. When the server drops the socket
   * (`socket.disconnect()` server-side, reason `io server disconnect`) Socket.IO
   * does **not** auto-reconnect — by design the client is meant to stay down.
   * That silently kills a long-lived client after a backend restart or an
   * auth-gate drop: the WebSocket is gone for good and nothing recovers it.
   *
   * With this set, the client recycles itself instead — after the given delay it
   * reconnects on the same socket, which re-reads the `auth` function (so a
   * rotated token is picked up automatically, exactly like an ordinary
   * reconnect). Other disconnect reasons (`transport close`, `ping timeout`, …)
   * are untouched — Socket.IO's own reconnection already handles those.
   *
   * Set `false` to keep Socket.IO's default (stay disconnected). Default `1000` ms.
   */
  reconnectOnServerDisconnect?: number | false;
  /**
   * Server → client events to **retain** ("sticky events"). The client keeps the
   * last payload of each listed event and replays it to any handler subscribed
   * afterwards (and on the next subscribe after a re-render), so a late
   * subscriber catches up to the current state at once instead of waiting for the
   * next emission. The retained value survives a `disconnect()` / `connect()`
   * cycle. Only the first emitted argument of an event is retained.
   */
  retain?: Array<keyof TServerEvents & string>;
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
  /**
   * Subscribe to connection up/down changes. Returns an unsubscribe. On a
   * disconnect the listener also receives the Socket.IO **reason** (e.g.
   * `io server disconnect`, `transport close`, `ping timeout`) as a second
   * argument — `undefined` on connect. The extra argument is additive: a
   * `(connected: boolean) => void` listener keeps working unchanged.
   */
  onConnectionChange(listener: (connected: boolean, reason?: string) => void): () => void;
}

export interface RealtimeClient<
  TServerToClient extends RealtimeEventRegistry,
  TClientToServer extends RealtimeEventRegistry,
> extends ValidatedRealtimeSocket<TServerToClient, TClientToServer> {
  connect(): void;
  disconnect(): void;
  readonly connected: boolean;
  onConnectionChange(listener: (connected: boolean, reason?: string) => void): () => void;
}

export interface RealtimeClientOptions<TServerToClient extends RealtimeEventRegistry>
  extends SocketIOClientConfig<{
    [TEvent in keyof TServerToClient]: (...args: unknown[]) => void;
  }> {
  onRejected?: RealtimeRejectedEventHook;
}

export function createRealtimeClient<
  const TServerToClient extends RealtimeEventRegistry,
  const TClientToServer extends RealtimeEventRegistry,
>(
  contract: RealtimeContract<TServerToClient, TClientToServer>,
  { onRejected, ...config }: RealtimeClientOptions<TServerToClient>,
): RealtimeClient<TServerToClient, TClientToServer> {
  const transport = createSocketIOClient<SocketEventMap, SocketEventMap>(config);
  const events = createValidatedRealtimeSocket({
    target: transport,
    inbound: contract.serverToClient,
    outbound: contract.clientToServer,
    inboundDirection: 'client-inbound',
    outboundDirection: 'client-outbound',
    onRejected,
    subscribe: (event, handler) => {
      const subscribe = Reflect.get(transport, 'on');
      if (typeof subscribe !== 'function') {
        throw new Error('Socket.IO client does not implement on()');
      }
      const unsubscribe = Reflect.apply(subscribe, transport, [event, handler]);
      if (typeof unsubscribe !== 'function') {
        throw new Error('Socket.IO client on() did not return an unsubscribe function');
      }
      return () => {
        Reflect.apply(unsubscribe, undefined, []);
      };
    },
  });
  return {
    ...events,
    connect: transport.connect,
    disconnect: transport.disconnect,
    get connected() {
      return transport.connected;
    },
    onConnectionChange: transport.onConnectionChange,
  };
}

export function createSocketIOClient<
  TServerEvents extends SocketEventMap,
  TClientEvents extends SocketEventMap,
>(config: SocketIOClientConfig<TServerEvents>): SocketIOClient<TServerEvents, TClientEvents> {
  // The internal socket keeps Socket.IO's default (loose) event typing — the
  // public methods below are the fully-typed surface. Socket.IO's emitter is a
  // conditional-typed API that cannot be forwarded through a generic wrapper;
  // the default-typed socket lets the delegation stay cast-free.
  let socket: ClientSocket | null = null;
  // Whether a connection is wanted right now — the source of truth the async
  // peer load reconciles against. `connect()` sets it, `disconnect()` clears it;
  // if a disconnect races the load, the resolved `io` is discarded.
  let desiredConnected = false;
  // Pending server-disconnect recycle timer (see `reconnectOnServerDisconnect`).
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const serverDisconnectDelay = config.reconnectOnServerDisconnect ?? 1000;
  const connectionListeners = new Set<(connected: boolean, reason?: string) => void>();
  // Durable event subscriptions — each re-attaches itself onto a fresh socket.
  const subscriptions = new Set<(socket: ClientSocket) => void>();
  // Sticky events — retained last value per topic. The store lives outside the
  // socket, so a retained value survives a disconnect()/connect() cycle; each
  // value is the event's first emitted argument.
  const retainNames = config.retain ? config.retain.map(String) : [];
  const retainSet = new Set(retainNames);
  const retained =
    retainNames.length > 0 ? createRetainedTopics<Record<string, unknown>>() : null;

  function notifyConnection(connected: boolean, reason?: string): void {
    for (const listener of connectionListeners) listener(connected, reason);
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  // Build the underlying socket once the peer `io` factory has loaded. A
  // `disconnect()` (or a second `connect()` that already built one) may have
  // raced the async load — so only build when a connection is still wanted and
  // none exists yet.
  function openSocket(io: IoFn): void {
    if (!desiredConnected || socket) return;

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
    socket.on('disconnect', (reason) => {
      notifyConnection(false, reason);
      // A server-initiated disconnect halts Socket.IO's own reconnection.
      // Recycle manually so the client recovers (re-reading `auth`). Capture
      // the current socket so a later disconnect()/connect() can't be recycled
      // onto a stale instance.
      if (reason === 'io server disconnect' && serverDisconnectDelay !== false) {
        const current = socket;
        clearReconnectTimer();
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (socket === current && current && !current.connected) current.connect();
        }, serverDisconnectDelay);
      }
    });
    // Record retained events' latest payload, independent of any user handler,
    // so the value is available to a subscriber that connects later. Attached
    // before connect so a handshake-time emission is captured too.
    if (retained) {
      for (const name of retainNames) {
        socket.on(name, (payload: unknown) => retained.record(name, payload));
      }
    }
    // Re-attach every registered handler BEFORE connecting — nothing emitted
    // during the handshake (e.g. an `authenticated` reply) can be missed.
    for (const attach of subscriptions) attach(socket);

    socket.connect();
  }

  return {
    get connected() {
      return socket?.connected ?? false;
    },

    connect() {
      // Idempotent: already connected, or a peer load is already in flight.
      if (socket || desiredConnected) return;
      desiredConnected = true;
      // `socket.io-client` loads lazily — the socket appears a tick later. Every
      // method already tolerates a null socket (durable subscriptions attach on
      // build, `emit` no-ops while disconnected), so callers see no difference
      // beyond the connection opening asynchronously, as it always did.
      void loadIo().then(openSocket);
    },

    disconnect() {
      // Mark the connection unwanted first — cancels an in-flight peer load and
      // any pending server-disconnect recycle; an explicit disconnect is a
      // deliberate teardown that a queued reconnect must not undo.
      desiredConnected = false;
      clearReconnectTimer();
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

      // Sticky replay — a late subscriber to a retained topic gets the last
      // value immediately. `fn` widens the (any-typed) listener to a loose call
      // signature by plain assignment, no cast (as with `name` above).
      if (retained && retainSet.has(name)) {
        const fn: (...args: unknown[]) => void = handler;
        retained.replay(name, (payload) => fn(payload));
      }

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
