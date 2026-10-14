import type { RealtimeContract, RealtimeEventRegistry } from '../realtime/contract';
import {
  RealtimeRequestDisconnectedError,
  type RealtimeRequestPhaseHook,
} from '../realtime/request';
import { bindRealtimeClient } from './realtime-client';
import {
  awaitAcknowledgement,
  connectErrorReport,
  createRecycle,
  createStickyEvents,
  ioOptions,
  reportPeerFailure,
} from './socket-io-connection';
import type {
  RealtimeClient,
  RealtimeClientOptions,
  SocketEventMap,
  SocketIOClient,
  SocketIOClientConfig,
} from './socket-io-contract';
import { createIoResolver, type IoFn } from './socket-io-peer';
import { createRequestTracer, realtimeRequestTraces } from './socket-io-trace';

type ClientSocket = ReturnType<IoFn>;

export function createRealtimeClientWithPeer<
  const TServerToClient extends RealtimeEventRegistry,
  const TClientToServer extends RealtimeEventRegistry,
>(
  contract: RealtimeContract<TServerToClient, TClientToServer>,
  { onRejected, logger, onRequestPhase, ...config }: RealtimeClientOptions<TServerToClient>,
  defaultIo: () => Promise<IoFn>,
): RealtimeClient<TServerToClient, TClientToServer> {
  const transport = createSocketIOClientInternal<SocketEventMap, SocketEventMap>(
    config,
    defaultIo,
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

export function createSocketIOClientWithPeer<
  TServerEvents extends SocketEventMap,
  TClientEvents extends SocketEventMap,
>(
  config: SocketIOClientConfig<TServerEvents>,
  defaultIo: () => Promise<IoFn>,
): SocketIOClient<TServerEvents, TClientEvents> {
  return createSocketIOClientInternal(config, defaultIo);
}

function createSocketIOClientInternal<
  TServerEvents extends SocketEventMap,
  TClientEvents extends SocketEventMap,
>(
  config: SocketIOClientConfig<TServerEvents>,
  defaultIo: () => Promise<IoFn>,
  onRequestPhase?: RealtimeRequestPhaseHook,
): SocketIOClient<TServerEvents, TClientEvents> {
  // The internal socket keeps Socket.IO's default (loose) event typing — the
  // public methods below are the fully-typed surface. Socket.IO's emitter is a
  // conditional-typed API that cannot be forwarded through a generic wrapper;
  // the default-typed socket lets the delegation stay cast-free.
  let socket: ClientSocket | null = null;
  const resolveIo = createIoResolver(config.peers?.client, defaultIo);
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
