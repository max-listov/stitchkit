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
import { isModuleNotFound } from '../internal/optional-peer';
import type { StitchLogger } from '../logger';
import type {
  RealtimeAcknowledgedEvent,
  RealtimeAcknowledgement,
  RealtimeContract,
  RealtimeEventRegistry,
  RealtimeRejectedEventHook,
  RealtimeRequestArguments,
} from '../realtime/contract';
import {
  RealtimeRequestDisconnectedError,
  type RealtimeRequestOptions,
  type RealtimeRequestPhase,
  type RealtimeRequestPhaseEvent,
  type RealtimeRequestPhaseHook,
  RealtimeRequestTimeoutError,
} from '../realtime/request';
import {
  createValidatedRealtimeSocket,
  parseRealtimeRequestAcknowledgement,
  parseRealtimeRequestArguments,
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

interface RealtimeRequestTrace {
  readonly requestId: string;
  readonly event: string;
  readonly startedAt: number;
  readonly observeClient?: RealtimeRequestPhaseHook;
  readonly observeRequest?: RealtimeRequestPhaseHook;
  nativeKey?: string;
  closed: boolean;
}

const realtimeRequestTraces = new WeakMap<Promise<unknown>, RealtimeRequestTrace>();

function observeRealtimeRequestPhase(
  trace: RealtimeRequestTrace,
  phase: RealtimeRequestPhase,
): void {
  const observation: RealtimeRequestPhaseEvent = {
    requestId: trace.requestId,
    event: trace.event,
    phase,
    elapsedMs: performance.now() - trace.startedAt,
  };
  const observers =
    trace.observeRequest && trace.observeRequest !== trace.observeClient
      ? [trace.observeClient, trace.observeRequest]
      : [trace.observeClient ?? trace.observeRequest];
  for (const observer of observers) {
    if (!observer) continue;
    try {
      const result = observer(observation);
      if (result) void Promise.resolve(result).catch(() => undefined);
    } catch {
      // Observability is isolated: a broken observer cannot change request truth.
    }
  }
}

interface SocketIoPacketIdentity {
  readonly namespace: string;
  readonly id: string;
}

/** Read only the Socket.IO packet envelope prefix; payload JSON is never parsed. */
function socketIoPacketIdentity(
  data: unknown,
  expected: 'event' | 'ack',
): SocketIoPacketIdentity | null {
  if (typeof data !== 'string') return null;
  const type = data.charAt(0);
  const binary = type === (expected === 'event' ? '5' : '6');
  if (type !== (expected === 'event' ? '2' : '3') && !binary) return null;

  let offset = 1;
  if (binary) {
    const separator = data.indexOf('-', offset);
    if (separator < 0) return null;
    for (let index = offset; index < separator; index += 1) {
      const code = data.charCodeAt(index);
      if (code < 48 || code > 57) return null;
    }
    offset = separator + 1;
  }

  let namespace = '/';
  if (data.charAt(offset) === '/') {
    const separator = data.indexOf(',', offset);
    if (separator < 0) return null;
    namespace = data.slice(offset, separator);
    offset = separator + 1;
  }

  const start = offset;
  while (offset < data.length) {
    const code = data.charCodeAt(offset);
    if (code < 48 || code > 57) break;
    offset += 1;
  }
  if (offset === start) return null;
  return { namespace, id: data.slice(start, offset) };
}

function packetIdentityKey(identity: SocketIoPacketIdentity): string {
  return `${identity.namespace}:${identity.id}`;
}

// Held in a variable, not a string literal, on purpose: under `--target node`
// the bundler rewrites a *literal* external dynamic import into a `createRequire`
// shim, which drags `node:module` into the browser graph (caught by
// `check-browser-clean`). A non-literal specifier stays a native `import()`.
const SOCKET_IO_CLIENT = 'socket.io-client';

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

// The peer module, loaded once and shared by every client that does NOT inject
// a loader. Failure clears the cache so a later `connect()` can retry, and
// reports the missing peer clearly (the same courtesy `stitchkit/server` gives
// for its Socket.IO server peer).
let ioLoader: Promise<IoFn> | null = null;
function loadIo(): Promise<IoFn> {
  if (!ioLoader) {
    // Webpack must leave this runtime-selected optional peer alone. Without
    // the magic comment it reports an expression dependency even when a
    // consumer supplies the literal `peers.client` loader below.
    ioLoader = import(/* webpackIgnore: true */ SOCKET_IO_CLIENT).then(
      (mod: typeof import('socket.io-client')) => mod.io,
      (cause) => {
        ioLoader = null;
        throw new Error(
          'stitchkit: createSocketIOClient needs the "socket.io-client" peer — install it (e.g. `bun add socket.io-client`). Shipping one self-contained artifact instead? Pass `peers: { client: () => import(\'socket.io-client\') }` so your bundler puts it inside.',
          { cause },
        );
      },
    );
  }
  return ioLoader;
}

/**
 * The one boundary where the injected module regains its type.
 *
 * `io` is a callable with properties, so the check is "callable" — anything
 * stricter would refuse a legitimate module and anything looser would let a
 * namespace object through to fail later as `io is not a function`.
 */
function isIoModule(module: unknown): module is { io: IoFn } {
  if (typeof module !== 'object' || module === null) return false;
  return typeof Reflect.get(module, 'io') === 'function';
}

/**
 * One client's way of getting to `io`, memoised.
 *
 * An injected loader is never put in the module-level cache: two clients in one
 * process may legitimately be built by different bundles, and one of them
 * winning a shared slot would decide which module the other uses.
 */
function createIoResolver(injected: SocketIOClientPeerLoaders['client']): () => Promise<IoFn> {
  if (!injected) return loadIo;
  let pending: Promise<IoFn> | null = null;
  return () => {
    if (!pending) {
      pending = injected().then(
        (module: unknown) => {
          // Refused by name rather than failing later as `io is not a function`
          // — the loader is consumer-written and the likely slip is returning
          // the default export or a namespace that has no `io`. This is also
          // the boundary where the module regains its type, since the loader
          // is declared `() => Promise<unknown>` to keep `socket.io-client`
          // out of the browser entry's declarations.
          const io = isIoModule(module) ? module.io : null;
          if (!io) {
            pending = null;
            throw new Error(
              'stitchkit: the loader passed in `peers.client` did not return the "socket.io-client" module — it must resolve to the module itself, as `() => import(\'socket.io-client\')`.',
            );
          }
          return io;
        },
        (cause: unknown) => {
          pending = null;
          // Only a MISSING MODULE is re-explained. A loader that throws for its
          // own reasons is not a packaging problem, and reporting it as one
          // sends the reader after the wrong thing.
          if (!isModuleNotFound(cause)) throw cause;
          // A different fix from the default path: an injected loader failing
          // means the BUNDLE does not contain the package, and installing
          // something on the machine is the wrong answer for an artifact meant
          // to be self-contained.
          throw new Error(
            'stitchkit: createSocketIOClient could not load "socket.io-client" through the loader passed in `peers` — the artifact does not contain it. Check that the loader is a literal `import(\'socket.io-client\')` your bundler can follow, and that "socket.io-client" is a dependency of the package being bundled.',
            { cause },
          );
        },
      );
    }
    return pending;
  };
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
export type RealtimeClientTransport = Pick<
  SocketIOClient<SocketEventMap, SocketEventMap>,
  'connected' | 'on' | 'emit' | 'emitWithAck' | 'onConnectionChange'
>;

export interface BoundRealtimeClient<
  TServerToClient extends RealtimeEventRegistry,
  TClientToServer extends RealtimeEventRegistry,
> extends ValidatedRealtimeSocket<TServerToClient, TClientToServer> {
  readonly connected: boolean;
  request<TEvent extends RealtimeAcknowledgedEvent<TClientToServer>>(
    event: TEvent,
    ...args: [
      ...RealtimeRequestArguments<TClientToServer[TEvent]>,
      options: RealtimeRequestOptions,
    ]
  ): Promise<RealtimeAcknowledgement<TClientToServer[TEvent]>>;
  onConnectionChange(listener: (connected: boolean, reason?: string) => void): () => void;
}

export interface RealtimeClient<
  TServerToClient extends RealtimeEventRegistry,
  TClientToServer extends RealtimeEventRegistry,
> extends BoundRealtimeClient<TServerToClient, TClientToServer> {
  connect(): void;
  disconnect(): void;
}

export interface BindRealtimeClientOptions {
  onRejected?: RealtimeRejectedEventHook;
  logger?: StitchLogger;
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

function assertRealtimeClientTransport(transport: RealtimeClientTransport): void {
  for (const capability of ['on', 'emit', 'emitWithAck', 'onConnectionChange']) {
    if (typeof Reflect.get(transport, capability) !== 'function') {
      throw new TypeError(`Realtime client transport does not implement ${capability}()`);
    }
  }
  if (typeof transport.connected !== 'boolean') {
    throw new TypeError('Realtime client transport does not expose boolean connected');
  }
}

/** Add contract validation and typed acknowledgements without owning the transport lifecycle. */
export function bindRealtimeClient<
  const TServerToClient extends RealtimeEventRegistry,
  const TClientToServer extends RealtimeEventRegistry,
>(
  contract: RealtimeContract<TServerToClient, TClientToServer>,
  transport: RealtimeClientTransport,
  { onRejected, logger }: BindRealtimeClientOptions = {},
): BoundRealtimeClient<TServerToClient, TClientToServer> {
  assertRealtimeClientTransport(transport);
  const events = createValidatedRealtimeSocket({
    target: transport,
    inbound: contract.serverToClient,
    outbound: contract.clientToServer,
    inboundDirection: 'client-inbound',
    outboundDirection: 'client-outbound',
    onRejected,
    logger,
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

  async function request<TEvent extends RealtimeAcknowledgedEvent<TClientToServer>>(
    event: TEvent,
    ...args: [
      ...RealtimeRequestArguments<TClientToServer[TEvent]>,
      options: RealtimeRequestOptions,
    ]
  ): Promise<RealtimeAcknowledgement<TClientToServer[TEvent]>> {
    const options = args.at(-1);
    if (!options || typeof options !== 'object' || !('timeoutMs' in options)) {
      throw new TypeError(`Realtime request "${event}" requires { timeoutMs }`);
    }
    const timeoutMs = options.timeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError(`Realtime request "${event}" timeoutMs must be finite and > 0`);
    }
    const values = args.slice(0, -1);
    const parsedArgs = parseRealtimeRequestArguments(
      contract.clientToServer,
      event,
      'client-outbound',
      values,
    );
    const definition = contract.clientToServer[event];
    if (!definition?.ack) {
      throw new Error(`Realtime request "${event}" has no acknowledgement schema`);
    }
    const pending = transport.emitWithAck(event, parsedArgs, options);
    const trace = realtimeRequestTraces.get(pending);
    if (trace) realtimeRequestTraces.delete(pending);
    const value = await pending;
    let acknowledgement: unknown;
    try {
      acknowledgement = parseRealtimeRequestAcknowledgement(
        definition.ack,
        event,
        'client-inbound',
        value,
        onRejected,
        logger,
      );
    } finally {
      if (trace && !trace.closed) {
        trace.closed = true;
        observeRealtimeRequestPhase(trace, 'settled');
      }
    }
    // Boundary cast: Socket.IO's emitter returns `unknown`; the selected
    // contract key and successful Zod ack parse above prove the conditional
    // acknowledgement output that TypeScript cannot retain through registry
    // indexing.
    return acknowledgement as RealtimeAcknowledgement<TClientToServer[TEvent]>;
  }

  return {
    ...events,
    get connected() {
      return transport.connected;
    },
    request,
    onConnectionChange: (listener) => transport.onConnectionChange(listener),
  };
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
  // Pending server-disconnect recycle timer (see `reconnectOnServerDisconnect`).
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingRequestDisconnects = new Set<() => void>();
  const requestTracesByNativeKey = new Map<string, RealtimeRequestTrace>();
  const observedRequestEngines = new WeakSet<object>();
  let startingRequestTrace: RealtimeRequestTrace | null = null;
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

  function attachRequestPhaseEngineListeners(target: ClientSocket): void {
    const engine = target.io.engine;
    if (!engine || observedRequestEngines.has(engine)) return;
    observedRequestEngines.add(engine);
    engine.on('packetCreate', (packet) => {
      if (!startingRequestTrace || packet.type !== 'message') return;
      const identity = socketIoPacketIdentity(packet.data, 'event');
      if (!identity) return;
      const key = packetIdentityKey(identity);
      startingRequestTrace.nativeKey = key;
      requestTracesByNativeKey.set(key, startingRequestTrace);
      observeRealtimeRequestPhase(startingRequestTrace, 'engine-handoff');
    });
    engine.on('packet', (packet) => {
      if (packet.type !== 'message') return;
      const identity = socketIoPacketIdentity(packet.data, 'ack');
      if (!identity) return;
      const key = packetIdentityKey(identity);
      const trace = requestTracesByNativeKey.get(key);
      if (!trace || trace.closed) return;
      observeRealtimeRequestPhase(trace, 'engine-ack-received');
      requestTracesByNativeKey.delete(key);
    });
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

    if (onRequestPhase) {
      socket.io.on('open', () => {
        if (socket) attachRequestPhaseEngineListeners(socket);
      });
    }

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
    socket.io.on('reconnect_failed', () => {
      desiredConnected = false;
    });
    socket.on('connect_error', (error: Error) => {
      // `active === false` → socket.io has destroyed its own retry path (a
      // namespace middleware rejection is terminal); reset the connection
      // intent so a later `connect()` is not swallowed by the idempotence
      // guard and re-reads a function-form `auth`.
      const terminal = socket !== null && !socket.active;
      if (terminal) desiredConnected = false;
      config.onConnectError?.({
        message: error.message,
        data: Reflect.get(error, 'data'),
        terminal,
      });
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

  /**
   * A peer that will not load is a TERMINAL connection failure, and it is
   * reported as one.
   *
   * It used to be an unhandled rejection: `connect()` fired the load and
   * nothing was listening on the failure path, so a missing `socket.io-client`
   * took the process down at the first connect. The message was already the
   * right one — the loader has wrapped the cause in an explanatory error for a
   * long time — but an unhandled rejection is not something a caller can act
   * on, retry, or report: the only outcome available was the process dying.
   * For the self-contained-artifact consumer this adapter's `peers` option
   * exists for, that is the worst possible moment to have no choices.
   *
   * With no `onConnectError` the failure is still re-thrown, so a project that
   * asked for nothing keeps today's loud behaviour instead of a silent
   * never-connecting client.
   */
  function reportPeerFailure(error: unknown): void {
    // Cleared first: the attempt is over either way, and a later `connect()`
    // must be able to start a fresh one (the same reset a terminal
    // `connect_error` performs).
    desiredConnected = false;
    if (!config.onConnectError) throw error;
    config.onConnectError({
      message: error instanceof Error ? error.message : String(error),
      data: error,
      terminal: true,
    });
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
          reportPeerFailure(error);
        },
      );
    },

    disconnect() {
      // Mark the connection unwanted first — cancels an in-flight peer load and
      // any pending server-disconnect recycle; an explicit disconnect is a
      // deliberate teardown that a queued reconnect must not undo.
      desiredConnected = false;
      clearReconnectTimer();
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
      const name: string = event;
      if (!socket?.connected) {
        config.onDroppedEmit?.({ event: name, args });
        return false;
      }
      socket.emit(name, ...args);
      return true;
    },

    emitWithAck(event, args, options) {
      const trace: RealtimeRequestTrace | undefined =
        onRequestPhase || options.onPhase
          ? {
              requestId: crypto.randomUUID(),
              event,
              startedAt: performance.now(),
              observeClient: onRequestPhase,
              observeRequest: options.onPhase,
              closed: false,
            }
          : undefined;
      const closeTrace = (phase: 'timeout' | 'disconnected'): void => {
        if (!trace || trace.closed) return;
        trace.closed = true;
        if (trace.nativeKey) requestTracesByNativeKey.delete(trace.nativeKey);
        observeRealtimeRequestPhase(trace, phase);
      };
      const active = socket;
      if (!active?.connected) {
        const pending = Promise.reject(new RealtimeRequestDisconnectedError(event));
        closeTrace('disconnected');
        if (trace) realtimeRequestTraces.set(pending, trace);
        return pending;
      }
      if (trace) attachRequestPhaseEngineListeners(active);
      const pending = new Promise<unknown>((resolve, reject) => {
        let settled = false;
        const finish = (result: () => void): void => {
          if (settled) return;
          settled = true;
          pendingRequestDisconnects.delete(onDisconnect);
          active.off('disconnect', onDisconnect);
          result();
        };
        const onDisconnect = (): void => {
          finish(() => {
            closeTrace('disconnected');
            reject(new RealtimeRequestDisconnectedError(event));
          });
        };
        pendingRequestDisconnects.add(onDisconnect);
        active.on('disconnect', onDisconnect);
        let acknowledgement: Promise<unknown>;
        startingRequestTrace = trace ?? null;
        try {
          acknowledgement = active.timeout(options.timeoutMs).emitWithAck(event, ...args);
        } finally {
          startingRequestTrace = null;
        }
        void acknowledgement.then(
          (value) => finish(() => resolve(value)),
          () => {
            finish(() => {
              const connected = active.connected;
              closeTrace(connected ? 'timeout' : 'disconnected');
              reject(
                connected
                  ? new RealtimeRequestTimeoutError(event, options.timeoutMs)
                  : new RealtimeRequestDisconnectedError(event),
              );
            });
          },
        );
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
