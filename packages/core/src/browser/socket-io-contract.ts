import type { RealtimeEventRegistry } from '../realtime/contract';
import type { RealtimeRequestOptions, RealtimeRequestPhaseHook } from '../realtime/request';
import type { BindRealtimeClientOptions, BoundRealtimeClient } from './realtime-client';

/**
 * A literal optional Socket.IO peer loader owned by the consuming bundle.
 * Root clients may omit it and use lazy runtime resolution; `stitchkit/realtime`
 * requires it so its graph is compilable by Hermes without a computed import.
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
