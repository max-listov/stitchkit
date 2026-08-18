/** Bun-owned server adapter and its concrete public types. */
import { chmodSync, statSync, unlinkSync } from 'node:fs';
import { createHandler } from './create';
import {
  createServerLifecycle,
  type ManagedServerHandle,
  type ShutdownAdapter,
} from './shutdown';
import type { SocketIOServerLifecycle } from './socket-io';
import type {
  FetchComposition,
  FetchHandler,
  HandlerConfig,
  RawRoute,
  RawRouteContext,
} from './types';

/** The concrete `Bun.serve` server instance passed to Bun raw routes. */
export type BunServer = ReturnType<typeof Bun.serve>;
export type BunRawRoute = RawRoute<BunServer>;
export type BunRawRouteContext = RawRouteContext<BunServer>;
export type BunFetchHandler = FetchHandler<BunServer>;
export type BunFetchComposition = FetchComposition<BunServer>;
export type BunHandlerConfig = HandlerConfig<BunServer>;

type BunServeOptions = Parameters<typeof Bun.serve>[0];
type BunWebSocketHandlers = Bun.WebSocketHandler<unknown>;
type BunDevelopmentOptions = BunServeOptions extends { development?: infer T } ? T : never;

export type ServerPassthrough = Omit<
  BunServeOptions,
  'fetch' | 'port' | 'hostname' | 'unix' | 'routes' | 'websocket' | 'development'
>;

/**
 * Unix domain socket listener. The plain-string form binds the path as-is;
 * the object form additionally tightens the socket file mode after listen —
 * `mode: 0o600` is the right choice when access to the socket IS the
 * credential (a local daemon whose only auth is filesystem permission).
 */
export type UnixListenConfig = string | { path: string; mode?: number };

/** Bun-specific server config layered over the Fetch-clean handler config. */
export interface BunServerConfig extends BunHandlerConfig, BunFetchComposition {
  port?: number;
  hostname?: string;
  /**
   * Listen on a unix domain socket instead of a TCP port. Mutually exclusive
   * with `port`/`hostname`. A stale socket file left by a killed process is
   * reclaimed (probe-then-unlink, best-effort against concurrent starts); a
   * path answered by a live listener — or one this process may not probe —
   * fails loudly. Not compatible with the Socket.IO lifecycle (`socket`):
   * socket.io clients cannot dial a unix socket.
   */
  unix?: UnixListenConfig;
  websocket?: BunWebSocketHandlers;
  /** Full Stitchkit Socket.IO lifecycle; route and default websocket are mounted automatically. */
  socket?: SocketIOServerLifecycle;
  development?: BunDevelopmentOptions;
  bun?: ServerPassthrough;
}

export type BunServerHandle = ManagedServerHandle<BunServer>;

/**
 * Reclaim a stale socket file left behind by a killed process, refusing every
 * ambiguous case: a non-socket at the path, a socket owned by another user, a
 * path a live listener still answers, and a probe that timed out. The
 * liveness probe is a short subprocess connect (the only synchronous way to
 * dial a unix socket), run only when the file already exists.
 * Probe-then-unlink is best-effort — two processes racing the same path can
 * interleave between probe and bind; a local daemon accepts that window.
 */
function reclaimStaleUnixSocket(path: string): void {
  const stats = statSync(path, { throwIfNoEntry: false });
  if (stats === undefined) return;
  if (!stats.isSocket()) {
    throw new Error(
      `[stitchkit] createServer: "${path}" exists and is not a socket — refusing to remove it`,
    );
  }
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new Error(
      `[stitchkit] createServer: unix socket "${path}" is owned by another user — refusing to reclaim it`,
    );
  }
  // In a `bun build --compile` binary, execPath IS the application — spawning
  // it would rerun the whole daemon instead of the probe. Use the real
  // interpreter, or refuse loudly rather than guess.
  const standalone = Bun.main.startsWith('/$bunfs/');
  const interpreter = standalone ? Bun.which('bun') : process.execPath;
  if (!interpreter) {
    throw new Error(
      `[stitchkit] createServer: unix socket "${path}" already exists and no \`bun\` binary is on PATH to probe it from this compiled executable — remove the file manually if the previous process is dead`,
    );
  }
  const probe = Bun.spawnSync({
    cmd: [
      interpreter,
      '-e',
      'try { const socket = await Bun.connect({ unix: Bun.env.STITCHKIT_UNIX_PROBE ?? "", socket: { data() { return undefined; } } }); socket.end(); process.exit(0); } catch (error) { process.exit(error && typeof error === "object" && "code" in error && error.code === "EACCES" ? 2 : 1); }',
    ],
    env: { ...process.env, STITCHKIT_UNIX_PROBE: path },
    timeout: 2_000,
  });
  if (probe.exitedDueToTimeout) {
    // Ambiguous — a jammed-but-live listener looks identical to a dead one.
    throw new Error(
      `[stitchkit] createServer: liveness probe for unix socket "${path}" timed out — refusing to reclaim; remove the file manually if the previous process is dead`,
    );
  }
  if (probe.exitCode === 0 || probe.exitCode === 2) {
    throw new Error(
      `[stitchkit] createServer: unix socket "${path}" is already in use${probe.exitCode === 2 ? ' (connect permission denied)' : ' by a live listener'}`,
    );
  }
  unlinkSync(path);
}

/** Start the contract router through `Bun.serve`. */
export function createServer(config: BunServerConfig): BunServerHandle {
  const {
    websocket: configuredWebSocket,
    socket,
    development,
    bun: bunExtra,
    port = 3000,
    hostname,
  } = config;
  const unixPath = typeof config.unix === 'string' ? config.unix : config.unix?.path;
  const unixMode = typeof config.unix === 'string' ? undefined : config.unix?.mode;
  if (unixPath !== undefined) {
    // Bun silently starts a TCP server on the default port for `unix: ''` —
    // the exact inversion of what a socket-as-credential daemon intends.
    if (unixPath.length === 0) {
      throw new Error('[stitchkit] createServer: `unix` must be a non-empty socket path');
    }
    // Checked on the raw config: `port` has a default further down, and Bun
    // itself silently ignores `port` next to `unix` instead of erroring.
    if (config.port !== undefined || config.hostname !== undefined) {
      throw new Error(
        '[stitchkit] createServer: `unix` is mutually exclusive with `port`/`hostname`',
      );
    }
    if (socket) {
      throw new Error(
        '[stitchkit] createServer: the Socket.IO lifecycle cannot listen on a unix socket — socket.io clients dial TCP only',
      );
    }
  }
  const socketRoutePrefix = socket?.route.path.replace(/\*socketPath$/, '');
  // Boundary cast: Bun's handler data is opaque to the lifecycle wrapper. The
  // wrapper preserves the same socket object and only observes open/close;
  // consumer and bun-engine handlers retain their own typed data internally.
  const websocket = (configuredWebSocket ?? socket?.websocket) as
    | Bun.WebSocketHandler<unknown>
    | undefined;
  const openSockets = new Set<Bun.ServerWebSocket<unknown>>();
  const socketDrainWaiters = new Set<() => void>();
  let hadWebSockets = false;
  const resolveSocketDrain = () => {
    if (openSockets.size !== 0) return;
    for (const resolve of socketDrainWaiters) resolve();
    socketDrainWaiters.clear();
  };
  const waitForSocketDrain = () => {
    if (openSockets.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => socketDrainWaiters.add(resolve));
  };
  const trackedWebSocket: typeof websocket = websocket
    ? {
        ...websocket,
        open(ws: Bun.ServerWebSocket<unknown>) {
          hadWebSockets = true;
          openSockets.add(ws);
          websocket.open?.(ws);
        },
        close(ws: Bun.ServerWebSocket<unknown>, code: number, reason: string) {
          openSockets.delete(ws);
          resolveSocketDrain();
          websocket.close?.(ws, code, reason);
        },
      }
    : undefined;

  let runtime: BunServer | undefined;
  const requireRuntime = (): BunServer => {
    if (!runtime) throw new Error('[stitchkit] Bun server lifecycle started before Bun.serve');
    return runtime;
  };
  const adapter: ShutdownAdapter = {
    beginShutdown: () => socket?.beginShutdown(),
    pendingRequests: () => runtime?.pendingRequests ?? 0,
    pendingWebSockets: () => openSockets.size,
    async closeRealtime() {
      const logicalClose = socket?.close();
      // bun-engine and raw lanes expose no physical-completion Promise. Start a
      // normal close handshake for every tracked socket, then wait for Bun's
      // close callback. The shared lifecycle deadline owns the fallback to
      // terminate() for any socket Bun still reports as open at that boundary.
      for (const ws of openSockets) ws.close(1001, 'Server shutting down');
      await Promise.all([logicalClose, waitForSocketDrain()]);
    },
    async stopGracefully() {
      // After all accepted work and tracked WebSockets are physically gone,
      // stop(true) only closes idle keep-alive transports; it cannot abort
      // application work. Bun's stop(false) otherwise remains pending after an
      // upgraded socket even when pendingWebSockets has already reached zero.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const server = requireRuntime();
      if (server.pendingRequests === 0 && openSockets.size === 0) {
        const stopping = server.stop(true);
        if (!hadWebSockets) await stopping;
        else void stopping.catch(() => undefined);
        return;
      }
      await server.stop(false);
    },
    async forceStop() {
      const logicalClose = socket?.close();
      const physicalClose = waitForSocketDrain();
      for (const ws of [...openSockets]) ws.terminate();
      const stopping = requireRuntime().stop(true);
      // Bun 1.3.14 closes the listener synchronously and emits the physical
      // server-side WebSocket close callback, but its stop Promise remains
      // pending after an upgraded connection. The tracker callback is therefore
      // the physical completion boundary; awaiting `stopping` would deadlock an
      // otherwise closed server.
      if (!hadWebSockets) await stopping;
      else void stopping.catch(() => undefined);
      await Promise.all([logicalClose, physicalClose]);
    },
  };
  const lifecycle = createServerLifecycle(() => adapter);

  const handler = createHandler(config);
  const consumerFetch = config.wrapFetch ? config.wrapFetch(handler) : handler;
  const admittedFetch = lifecycle.wrapFetch(consumerFetch);
  const fetch: BunFetchHandler = async (request, server) => {
    if (socket && socketRoutePrefix) {
      const pathname = new URL(request.url).pathname;
      if (pathname.startsWith(socketRoutePrefix)) {
        return await socket.route.handler(request, {
          params: { socketPath: pathname.slice(socketRoutePrefix.length) },
          server,
        });
      }
    }
    return admittedFetch(request, server);
  };

  if (unixPath !== undefined) {
    reclaimStaleUnixSocket(unixPath);
    // The unix branch carries no `port`/`hostname` keys at all — Bun accepts
    // and silently ignores `port` beside `unix`, which would mask config bugs.
    // TCP-only passthrough keys are stripped the same way: Bun's unix options
    // variant types them out, and they are meaningless on a socket file.
    const { reusePort, ipv6Only, http3, http1, idleTimeout, ...unixExtra } = bunExtra ?? {};
    void reusePort;
    void ipv6Only;
    void http3;
    void http1;
    void idleTimeout;
    runtime = trackedWebSocket
      ? Bun.serve({
          ...unixExtra,
          ...(development && { development }),
          unix: unixPath,
          websocket: trackedWebSocket,
          fetch,
        })
      : Bun.serve({
          ...unixExtra,
          ...(development && { development }),
          unix: unixPath,
          fetch,
        });
    if (unixMode !== undefined) chmodSync(unixPath, unixMode);
  } else {
    runtime = trackedWebSocket
      ? Bun.serve({
          ...bunExtra,
          ...(development && { development }),
          port,
          hostname,
          websocket: trackedWebSocket,
          fetch,
        })
      : Bun.serve({
          ...bunExtra,
          ...(development && { development }),
          port,
          hostname,
          fetch,
        });
  }

  const server = runtime;
  return {
    // In unix mode this is `unix://<path>` — an identifier, not a fetchable
    // address (clients dial the path via `createHttpClient({ unix })`).
    url: server.url.toString().replace(/\/$/, ''),
    port: server.port ?? (unixPath !== undefined ? 0 : port),
    runtime: server,
    get status() {
      return lifecycle.status;
    },
    shutdown: lifecycle.shutdown,
  };
}
