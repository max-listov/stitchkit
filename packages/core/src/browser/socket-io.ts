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

import type { RealtimeContract, RealtimeEventRegistry } from '../realtime/contract';
import {
  RealtimeRequestDisconnectedError,
  type RealtimeRequestOptions,
  type RealtimeRequestPhaseHook,
} from '../realtime/request';
import {
  type BindRealtimeClientOptions,
  type BoundRealtimeClient,
  bindRealtimeClient,
} from './realtime-client';
import {
  awaitAcknowledgement,
  connectErrorReport,
  createRecycle,
  createStickyEvents,
  ioOptions,
  reportPeerFailure,
} from './socket-io-connection';
import { createIoResolver, type IoFn } from './socket-io-peer';
import { createRequestTracer, realtimeRequestTraces } from './socket-io-trace';

// `socket.io-client` is loaded lazily (see `loadIo`) so it stays OUT of the
// root `stitchkit` entry's eager graph — importing `defineContract` must not
// drag the Socket.IO client into a bundle that never opens a socket. The type
// is pulled via a type-only `import(...)` query, which is fully erased.

/** The concrete Socket.IO client socket type (loose, default event typing). */
type ClientSocket = ReturnType<IoFn>;

/**
 * How this project loads the optional Socket.IO **client** peer.
 *
 * The mirror of `SocketIOPeerLoaders` on the server, and for the same reason.
 * The specifier above is a variable, so no bundler can follow it — by
 * construction, not by accident. A consumer who ships one self-contained file
 * to a machine with no `node_modules` therefore had no way to get
 * `socket.io-client` into the artifact, and learned about it at the first
 * `connect()` rather than at build time. The only workaround was patching
 * stitchkit's built `dist`, which breaks whenever its internal layout moves —
 * exactly the dead end the server half was added to close.
 *
 * Passing a loader puts the literal in the CONSUMER's source, where their own
 * bundler sees it statically and includes the package:
 *
 * ```ts
 * createSocketIOClient({
 *   url,
 *   peers: { client: () => import('socket.io-client') },
 * })
 * ```
 *
 * A function rather than an already-resolved module, so laziness is unchanged:
 * a project that never opens a socket still never loads it.
 */
export interface SocketIOClientPeerLoaders {
  /**
   * `() => import('socket.io-client')`.
   *
   * Typed as `unknown` and shape-checked where it is used — the same reason
   * `SocketIOPeerLoaders.bunEngine` is. The root `stitchkit` entry is the
   * browser-safe one, and its declarations must not name `socket.io-client`:
   * a consumer who imports `createClient` and never opens a socket would then
   * need the package installed just to TYPECHECK, which the consumer-lane peer
   * budget refuses by name. The loader is still written the obvious way; only
   * the type of what it returns is checked at the boundary rather than here,
   * and a loader that returns the wrong module is refused by name at runtime.
   */
  client?: () => Promise<unknown>;
}

/**
 * Socket.IO event map — `{ event: (...args) => void }`. Aliases Socket.IO's
 * own event-map constraint, which intentionally maps to `any`: that is what
 * lets a plain `interface ServerToClientEvents { … }` (no index signature) be
 * passed as a type argument. The constraint lives here instead of importing
 * Socket.IO's equivalent: the root HTTP client declarations must remain usable
 * when no optional Socket.IO peer is installed. Per-event typing is fully
 * preserved on the public `on` / `emit` signatures.
 */
export interface SocketEventMap {
  // Transport boundary: Socket.IO deliberately uses `any` here so a normal
  // event interface without a string index signature satisfies the constraint.
  // Replacing it with `unknown` rejects those interfaces under TypeScript.
  [event: string]: any;
}

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
  /**
   * Observe handshake/connection failures (`connect_error`). `terminal: true`
   * means socket.io will NOT retry on its own — that is how a server-side
   * handshake gate rejection (`io.use` middleware / the stitchkit `handshake`
   * option, `data.code === 'handshake_rejected'`) arrives, unlike a
   * transport-level failure which keeps retrying. On a terminal error the
   * client resets its connection intent, so a later `connect()` starts a fresh
   * attempt and re-reads a function-form `auth` — the recovery path after
   * rotating a rejected token. For transport-level failures (server down) the
   * hook fires once **per retry attempt** — debounce before wiring it to
   * user-facing alerts.
   */
  onConnectError?: (error: { message: string; data?: unknown; terminal: boolean }) => void;
  /**
   * Observe every emit dropped because the socket was disconnected (the
   * central alternative to guarding each call with `connected`). Receives the
   * **wire** arguments — for a validated `RealtimeClient` that is the
   * Zod-parsed values plus the wrapped ack callback, not the caller's original
   * arguments. The drop itself is also reported by `emit` returning `false`.
   */
  onDroppedEmit?: (dropped: { event: string; args: unknown[] }) => void;
  /**
   * How to load the optional `socket.io-client` peer. Omit it and the peer is
   * resolved lazily, exactly as before — this exists for a consumer who ships
   * one self-contained artifact and needs the specifier to be a literal their
   * own bundler can follow. → `SocketIOClientPeerLoaders`
   */
  peers?: SocketIOClientPeerLoaders;
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
  /**
   * Emit a client → server event. Returns `true` when the event was handed to
   * the transport (not a delivery guarantee) and `false` when it was dropped
   * because the socket is disconnected — including the window while the lazy
   * peer is still loading right after `connect()`. A drop also fires the
   * `onDroppedEmit` hook. The default stays a drop (no buffering): after a
   * reconnect the durable subscriptions replay state deterministically instead
   * of an unordered backlog of stale emits.
   */
  emit<E extends keyof TClientEvents & string>(
    event: E,
    ...args: Parameters<TClientEvents[E]>
  ): boolean;
  /**
   * Low-level native Socket.IO acknowledgement request. Contract-aware callers
   * should use `createRealtimeClient().request()`, which validates both sides.
   */
  emitWithAck(
    event: string,
    args: unknown[],
    options: RealtimeRequestOptions,
  ): Promise<unknown>;
  /**
   * Subscribe to connection up/down changes. Returns an unsubscribe. On a
   * disconnect the listener also receives the Socket.IO **reason** (e.g.
   * `io server disconnect`, `transport close`, `ping timeout`) as a second
   * argument — `undefined` on connect. The extra argument is additive: a
   * `(connected: boolean) => void` listener keeps working unchanged.
   */
  onConnectionChange(listener: (connected: boolean, reason?: string) => void): () => void;
}

/** Minimal Stitchkit client transport required by a validated realtime binding. */
export interface RealtimeClient<
  TServerToClient extends RealtimeEventRegistry,
  TClientToServer extends RealtimeEventRegistry,
> extends BoundRealtimeClient<TServerToClient, TClientToServer> {
  connect(): void;
  disconnect(): void;
}

export interface RealtimeClientOptions<TServerToClient extends RealtimeEventRegistry>
  extends BindRealtimeClientOptions,
    SocketIOClientConfig<{
      [TEvent in keyof TServerToClient]: (...args: unknown[]) => void;
    }> {
  /**
   * Observe bounded metadata-only phases of acknowledged requests. Engine.IO
   * phases are local encoder/decoder boundaries, not remote send time or RTT.
   * Observer failures are isolated from request lifecycle.
   */
  onRequestPhase?: RealtimeRequestPhaseHook;
}

export function createRealtimeClient<
  const TServerToClient extends RealtimeEventRegistry,
  const TClientToServer extends RealtimeEventRegistry,
>(
  contract: RealtimeContract<TServerToClient, TClientToServer>,
  { onRejected, logger, onRequestPhase, ...config }: RealtimeClientOptions<TServerToClient>,
): RealtimeClient<TServerToClient, TClientToServer> {
  const transport = createSocketIOClientInternal<SocketEventMap, SocketEventMap>(
    config,
    onRequestPhase,
  );
  const bound = bindRealtimeClient(contract, transport, { onRejected, logger });
  return {
    ...bound,
    get connected() {
      return bound.connected;
    },
    connect: transport.connect,
    disconnect: transport.disconnect,
  };
}

export function createSocketIOClient<
  TServerEvents extends SocketEventMap,
  TClientEvents extends SocketEventMap,
>(config: SocketIOClientConfig<TServerEvents>): SocketIOClient<TServerEvents, TClientEvents> {
  return createSocketIOClientInternal(config);
}

function createSocketIOClientInternal<
  TServerEvents extends SocketEventMap,
  TClientEvents extends SocketEventMap,
>(
  config: SocketIOClientConfig<TServerEvents>,
  onRequestPhase?: RealtimeRequestPhaseHook,
): SocketIOClient<TServerEvents, TClientEvents> {
  // The internal socket keeps Socket.IO's default (loose) event typing — the
  // public methods below are the fully-typed surface. Socket.IO's emitter is a
  // conditional-typed API that cannot be forwarded through a generic wrapper;
  // the default-typed socket lets the delegation stay cast-free.
  let socket: ClientSocket | null = null;
  const resolveIo = createIoResolver(config.peers?.client);
  // Whether a connection is wanted right now — the source of truth the async
  // peer load reconciles against. `connect()` sets it, `disconnect()` clears it;
  // if a disconnect races the load, the resolved `io` is discarded.
  let desiredConnected = false;
  // Whether a peer load is in flight. Separate from `desiredConnected`, because
  // `disconnect()` clears that while the load is still running: a
  // `connect() → disconnect() → connect()` sequence then saw "not connecting,
  // no socket" and attached a SECOND handler to the same pending promise, so one
  // failure was reported twice — `onConnectError` fired twice, or, with no hook,
  // threw twice. The success side was already idempotent (`openSocket` re-checks
  // intent); this is its missing counterpart.
  let loadingPeer = false;
  // Pending server-disconnect recycle (see `reconnectOnServerDisconnect`).
  const recycle = createRecycle(config.reconnectOnServerDisconnect ?? 1000);
  const pendingRequestDisconnects = new Set<() => void>();
  const tracer = createRequestTracer(onRequestPhase);
  const connectionListeners = new Set<(connected: boolean, reason?: string) => void>();
  // Durable event subscriptions — each re-attaches itself onto a fresh socket.
  const subscriptions = new Set<(socket: ClientSocket) => void>();
  const sticky = createStickyEvents(config.retain);

  function notifyConnection(connected: boolean, reason?: string): void {
    for (const listener of connectionListeners) listener(connected, reason);
  }

  // Build the underlying socket once the peer `io` factory has loaded. A
  // `disconnect()` (or a second `connect()` that already built one) may have
  // raced the async load — so only build when a connection is still wanted and
  // none exists yet.
  function openSocket(io: IoFn): void {
    if (!desiredConnected || socket) return;

    socket = io(config.url, ioOptions(config));

    tracer.observeEachOpen(socket, () => socket);

    socket.on('connect', () => notifyConnection(true));
    socket.on('disconnect', (reason) => {
      notifyConnection(false, reason);
      // A server-initiated disconnect halts Socket.IO's own reconnection.
      // Recycle manually so the client recovers (re-reading `auth`). Capture
      // the current socket so a later disconnect()/connect() can't be recycled
      // onto a stale instance.
      if (reason === 'io server disconnect') {
        const current = socket;
        recycle.schedule(() => {
          if (socket === current && current && !current.connected) current.connect();
        });
      }
    });
    socket.io.on('reconnect_failed', () => {
      desiredConnected = false;
    });
    socket.on('connect_error', (error: Error) => {
      const report = connectErrorReport(error, socket);
      if (report.terminal) desiredConnected = false;
      config.onConnectError?.(report);
    });
    sticky.record(socket);
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
      if (socket?.connected || desiredConnected) return;
      desiredConnected = true;
      if (socket) {
        socket.connect();
        return;
      }
      // `socket.io-client` loads lazily — the socket appears a tick later. Every
      // method already tolerates a null socket (durable subscriptions attach on
      // build; `emit` in this window drops — returns `false` and fires
      // `onDroppedEmit`), so callers see no difference beyond the connection
      // opening asynchronously, as it always did.
      if (loadingPeer) return;
      loadingPeer = true;
      void resolveIo().then(
        (io) => {
          loadingPeer = false;
          openSocket(io);
        },
        (error: unknown) => {
          loadingPeer = false;
          // Cleared first: the attempt is over either way, and a later
          // `connect()` must be able to start a fresh one.
          desiredConnected = false;
          reportPeerFailure(config, error);
        },
      );
    },

    disconnect() {
      // Mark the connection unwanted first — cancels an in-flight peer load and
      // any pending server-disconnect recycle; an explicit disconnect is a
      // deliberate teardown that a queued reconnect must not undo.
      desiredConnected = false;
      recycle.clear();
      for (const reject of [...pendingRequestDisconnects]) reject();
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
      const fn: (...args: unknown[]) => void = handler;
      sticky.replay(name, fn);

      return () => {
        subscriptions.delete(attach);
        socket?.off(name, handler);
      };
    },

    emit(event, ...args) {
      const name: string = event;
      if (!socket?.connected) {
        config.onDroppedEmit?.({ event: name, args });
        return false;
      }
      socket.emit(name, ...args);
      return true;
    },

    emitWithAck(event, args, options) {
      const trace = tracer.start(event, options.onPhase);
      const closeTrace = (phase: 'timeout' | 'disconnected') => tracer.close(trace, phase);
      const active = socket;
      if (!active?.connected) {
        const pending = Promise.reject(new RealtimeRequestDisconnectedError(event));
        closeTrace('disconnected');
        if (trace) realtimeRequestTraces.set(pending, trace);
        return pending;
      }
      if (trace) tracer.observe(active);
      const pending = awaitAcknowledgement({
        active,
        event,
        args,
        timeoutMs: options.timeoutMs,
        pendingRequestDisconnects,
        closeTrace,
        emit: () =>
          tracer.starting(trace, () =>
            active.timeout(options.timeoutMs).emitWithAck(event, ...args),
          ),
      });
      if (trace) realtimeRequestTraces.set(pending, trace);
      return pending;
    },

    onConnectionChange(listener) {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },
  };
}
