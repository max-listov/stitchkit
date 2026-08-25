/**
 * Socket.IO server setup — the family WebSocket server boilerplate, runtime-aware.
 *
 * The engine differs per runtime, so the socket packages are loaded **lazily**
 * (dynamic `import` inside the function) — a `type`-only import at the top would
 * still be erased, but a top-level *value* import of `@socket.io/bun-engine`
 * (Bun-only) would crash the whole `stitchkit/server` barrel on Node before any
 * socket code runs. Lazy loading keeps the barrel Node-importable for apps that
 * never use sockets.
 *
 *  - **Bun** — `@socket.io/bun-engine` + `io.bind(engine)`; returns the
 *    `websocket` handler for `Bun.serve` and a `/socket.io/*` route.
 *  - **Node** — `io.attach(server)` onto the `node:http.Server` exposed by
 *    `serveNode` (srvx `server.node.server`); Socket.IO owns the `upgrade` event.
 *
 * Connection handlers, rooms and handshake auth stay in the project.
 */
import type { Server as HttpServer } from 'node:http';
import type {
  Server as BunEngine,
  ServerOptions as BunEngineServerOptions,
} from '@socket.io/bun-engine';
import type { ServerWebSocket } from 'bun';
import type {
  DefaultEventsMap,
  Server as SocketIOServer,
  ServerOptions as SocketIOServerOptions,
  Socket as SocketIOSocket,
} from 'socket.io';
import type { SocketEventMap } from '../browser/socket-io';
import { isModuleNotFound } from '../internal/optional-peer';
import { transportResult } from '../internal/typed';
import type { BunServer } from './bun';
import type { SocketIOHandshakeConfig, SocketIOServerConfig } from './socket-io-config';
import type { RawRoute } from './types';
import { type ComposedLane, webSocketLane } from './websocket';

// Held in variables, not literal dynamic imports, so a consumer bundling an
// unrelated `stitchkit/server` export does not have to resolve these optional
// peers. The type-only annotations remain erased; opting into this adapter
// still loads and validates the peers at runtime.
//
// The other direction is `config.peers`: a consumer who DOES use this adapter
// and ships one self-contained file passes literal dynamic imports from their
// own source, where their bundler can see them. A variable is unfollowable by
// construction, which is the whole reason the escape hatch exists.
const SOCKET_IO_SERVER = 'socket.io';
const SOCKET_IO_BUN_ENGINE = '@socket.io/bun-engine';

export type {
  SocketIOHandshakeConfig,
  SocketIOPeerLoaders,
  SocketIORequestPolicy,
  SocketIOServerConfig,
} from './socket-io-config';

export interface SocketIOServerLifecycle {
  /**
   * WebSocket handler for `Bun.serve({ websocket })`. Real on Bun; on Node it is
   * an inert no-op — sockets there are driven by the `node:http.Server`
   * `upgrade` event via `serveNode({ socket })`, never by this field — so a Bun
   * consumer can pass it unconditionally without a runtime guard.
   */
  websocket: ReturnType<BunEngine['handler']>['websocket'];
  /**
   * `/socket.io/*socketPath` route for `createServer({ rawRoutes })`. Real on Bun; on Node
   * it is unused (sockets attach to the http.Server via `serveNode({ socket })`)
   * and throws if it is ever mounted — so it is safe to spread into `rawRoutes`
   * unconditionally on either runtime.
   */
  route: RawRoute<BunServer>;
  /**
   * Node only — attach the Socket.IO server to the `node:http.Server` from
   * `serveNode`. A no-op on Bun (the engine + route handle transport there).
   * `serveNode({ socket })` calls this for you.
   */
  attach(server: HttpServer): void;
  /** Stop admitting new Engine.IO handshakes. Called by the managed server. */
  beginShutdown(): void;
  /** Idempotently close namespaces, adapters and the bound transport engine. */
  close(): Promise<void>;
  /** Current Engine.IO client count, when the engine has been bound. */
  connections(): number;
}

export interface SocketIOServerHandle<
  TServerEvents extends SocketEventMap,
  TClientEvents extends SocketEventMap,
  TData = any,
> extends SocketIOServerLifecycle {
  /** The typed Socket.IO server — attach `io.on('connection', ...)` handlers. */
  io: SocketIOServer<TClientEvents, TServerEvents, DefaultEventsMap, TData>;
}

/** Inert handler for a runtime-irrelevant slot (Bun's `attach`, Node's `websocket`). */
const noop = (): void => {
  // intentionally empty
};

/** True when an import failed because the module is simply not installed. */
/**
 * Load an optional peer, turning a missing-module failure into an actionable
 * error that names the package and the install command — instead of a bare
 * `Cannot find module` surfacing from a dynamic import at bootstrap.
 */
async function importPeer<T>(
  load: () => Promise<T>,
  pkg: string,
  injected: boolean,
): Promise<T> {
  try {
    return await load();
  } catch (err) {
    if (isModuleNotFound(err)) {
      // The advice differs by how the peer was asked for, because the two
      // failures have different fixes. A default (lazy) load failing means the
      // package is not on the machine. An INJECTED loader failing means the
      // bundle did not include it after all — installing something on the
      // machine is the wrong answer for an artifact meant to be self-contained.
      throw new Error(
        injected
          ? `[stitchkit] createSocketIOServer could not load the optional peer "${pkg}" through the loader passed in \`peers\` — the artifact does not contain it. Check that the loader is a literal \`import('${pkg}')\` your bundler can follow, and that "${pkg}" is a dependency of the package being bundled.`
          : `[stitchkit] createSocketIOServer needs the optional peer "${pkg}" — install it: bun add ${pkg}. Shipping one self-contained artifact instead? Pass \`peers: { … }\` so your bundler puts it inside.`,
        { cause: err },
      );
    }
    throw err;
  }
}

/**
 * The one boundary where the Bun engine module regains its type.
 *
 * The loader is declared `() => Promise<unknown>` in the runtime-neutral config
 * so a Bun-only type never reaches a Node consumer's declarations. Here — on
 * the Bun path, in the module that already imports those types — the shape this
 * adapter actually uses is checked, and a loader that returned something else
 * is refused by name instead of failing later as `Engine is not a constructor`.
 */
function isBunEngineModule(value: unknown): value is { Server: typeof BunEngine } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'Server') === 'function'
  );
}

/**
 * Reject a handshake with a deterministic, client-inspectable error. The code
 * rides in `err.data` — socket.io delivers it to the client's `connect_error`.
 */
function handshakeRejection(message: string): Error {
  const error: Error & { data?: unknown } = new Error(message);
  error.data = { code: 'handshake_rejected' };
  return error;
}

/**
 * Build the identity-gate middleware. Socket.IO does NOT catch a rejected
 * promise from an async middleware (it leaks as an unhandledRejection and the
 * handshake hangs), so `verify` — sync or async — always runs inside a
 * settled promise chain that routes every outcome through `next`.
 */
function handshakeMiddleware<TParsed, TData>(
  handshake: SocketIOHandshakeConfig<TParsed, TData>,
): (
  socket: { handshake: SocketIOSocket['handshake']; data: TData },
  next: (err?: Error) => void,
) => void {
  return (socket, next) => {
    // safeParse itself can THROW synchronously (an async refine/transform in
    // the schema demands parseAsync) — and socket.io's middleware runner has
    // no try/catch, so an uncaught throw would escape into the engine.
    let parsed: ReturnType<typeof handshake.schema.safeParse>;
    try {
      parsed = handshake.schema.safeParse(socket.handshake.auth);
    } catch (error) {
      console.error('[stitchkit] handshake schema threw — use a synchronous schema', error);
      next(handshakeRejection('handshake auth failed validation'));
      return;
    }
    if (!parsed.success) {
      next(handshakeRejection('handshake auth failed validation'));
      return;
    }
    const verify = handshake.verify;
    void Promise.resolve()
      .then(() => {
        if (verify) return verify(parsed.data, { handshake: socket.handshake });
        // No `verify` → the API contract fixes TData to the schema output
        // (generic default `TData = TParsed`); the compiler cannot carry that
        // relation into this body — loose→typed bridge over Socket.IO's
        // natively untyped `data`.
        return transportResult<TData>(parsed.data);
      })
      .then(
        (identity) => {
          // `undefined` (an untyped JS verify that forgot to return) rejects
          // like `null` — passing the gate with no identity would be a lie.
          if (identity === null || identity === undefined) {
            next(handshakeRejection('handshake rejected'));
            return;
          }
          socket.data = identity;
          next();
        },
        (error: unknown) => {
          // The raw message never crosses to an UNAUTHENTICATED peer (same
          // policy as the HTTP error normalizer) — a verify that hits real
          // infrastructure would otherwise leak its failure details. The
          // error stays visible server-side.
          console.error('[stitchkit] handshake verify rejected', error);
          next(handshakeRejection('handshake rejected'));
        },
      );
  };
}

export async function createSocketIOServer<
  TServerEvents extends SocketEventMap,
  TClientEvents extends SocketEventMap,
  // `any`, not `unknown`: a no-`handshake` call must keep `socket.data: any`
  // (the pre-gate behavior) — `unknown` would break every consumer reading
  // `raw.data.x` before adopting the gate. Inference from `schema`/`verify`
  // overrides the default whenever `handshake` is present.
  TParsed = any,
  TData = TParsed,
>(
  config: SocketIOServerConfig<TParsed, TData>,
): Promise<SocketIOServerHandle<TServerEvents, TClientEvents, TData>> {
  const path = config.path ?? '/socket.io/';
  const onBun = 'Bun' in globalThis;
  const transports = config.transports ?? (onBun ? ['websocket', 'polling'] : ['websocket']);
  const pingTimeout = config.pingTimeout ?? 20_000;
  const pingInterval = config.pingInterval ?? 10_000;
  // Absent `cors` means same-origin: no headers are emitted at all, rather
  // than an empty allow-list that would read as "configured, allows nothing".
  const cors = config.cors
    ? {
        origin: config.cors.origin,
        credentials: config.cors.credentials ?? true,
        methods: ['GET', 'POST'],
      }
    : undefined;
  let accepting = true;
  let attached = false;
  let closePromise: Promise<void> | undefined;
  const consumerAllowRequest = config.allowRequest;
  const checkRequest = async (request: Request): Promise<void> => {
    if (consumerAllowRequest && !(await consumerAllowRequest(request))) {
      throw new Error('Request rejected by the configured Socket.IO policy');
    }
    if (!accepting) throw new Error('Server is shutting down');
  };
  const allowRequest: NonNullable<SocketIOServerOptions['allowRequest']> = (request, done) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) headers.append(name, item);
      } else if (value !== undefined) {
        headers.set(name, value);
      }
    }
    const host = headers.get('host') ?? 'localhost';
    const webRequest = new Request(new URL(request.url ?? '/', `http://${host}`), {
      method: request.method,
      headers,
    });
    void checkRequest(webRequest).then(
      () => done(null, true),
      (error: unknown) =>
        done(error instanceof Error ? error.message : 'Request rejected', false),
    );
  };

  const injectedServer = config.peers?.server;
  const { Server } = await importPeer(
    injectedServer ??
      (() => import(SOCKET_IO_SERVER).then((module: typeof import('socket.io')) => module)),
    SOCKET_IO_SERVER,
    injectedServer !== undefined,
  );
  const io = new Server<TClientEvents, TServerEvents, DefaultEventsMap, TData>({
    // Passthrough first; the wrapper-owned fields below override any overlap.
    ...config.serverOptions,
    path,
    cors,
    transports,
    pingTimeout,
    pingInterval,
    allowRequest,
  });
  // Registered before anything else (and before the runtime branch, so Bun and
  // Node share it) — app middlewares added on the returned `io` run after this
  // gate and see the typed identity already in `socket.data`.
  if (config.handshake) io.use(handshakeMiddleware(config.handshake));

  const lifecycle = {
    beginShutdown() {
      accepting = false;
    },
    close() {
      if (closePromise) return closePromise;
      closePromise = onBun || attached ? io.close() : Promise.resolve();
      return closePromise;
    },
    connections() {
      return io.engine?.clientsCount ?? 0;
    },
  };

  if (onBun) {
    const injectedEngine = config.peers?.bunEngine;
    const engineModule = await importPeer(
      injectedEngine ??
        (() =>
          import(SOCKET_IO_BUN_ENGINE).then(
            (module: typeof import('@socket.io/bun-engine')) => module,
          )),
      SOCKET_IO_BUN_ENGINE,
      injectedEngine !== undefined,
    );
    if (!isBunEngineModule(engineModule)) {
      throw new Error(
        `[stitchkit] the loader passed in \`peers.bunEngine\` did not return the "${SOCKET_IO_BUN_ENGINE}" module — it must resolve to the module itself, as \`() => import('${SOCKET_IO_BUN_ENGINE}')\`.`,
      );
    }
    const { Server: Engine } = engineModule;
    // socket.io forwards engine-level options to the engine only when it creates
    // the engine itself (the Node path). On Bun we build the engine by hand, so
    // they must be passed explicitly — otherwise `maxHttpBufferSize`, the ping
    // heartbeat and `upgradeTimeout` silently fall back to engine defaults and a
    // configured value is lost (a >1 MB emit truncates at the 1 MB default).
    const engineOpts: Partial<BunEngineServerOptions> = {
      path,
      cors,
      pingTimeout,
      pingInterval,
      allowRequest: checkRequest,
    };
    if (config.serverOptions?.maxHttpBufferSize !== undefined) {
      engineOpts.maxHttpBufferSize = config.serverOptions.maxHttpBufferSize;
    }
    if (config.serverOptions?.upgradeTimeout !== undefined) {
      engineOpts.upgradeTimeout = config.serverOptions.upgradeTimeout;
    }
    const engine = new Engine(engineOpts);
    io.bind(engine);
    const { websocket } = engine.handler();

    const route: RawRoute<BunServer> = {
      method: 'ALL',
      path: `${path.replace(/\/+$/, '')}/*socketPath`,
      handler: (req, ctx) => {
        // The Bun server is needed for the WebSocket upgrade. `createServer`
        // always provides it; its absence means the route was mounted on a bare
        // `createHandler` with no server — a wiring bug, so fail loud.
        if (!ctx.server) {
          throw new Error(
            '[stitchkit] createSocketIOServer route needs a running Bun server — mount it via createServer.',
          );
        }
        return engine.handleRequest(req, ctx.server);
      },
    };

    return { io, websocket, route, attach: noop, ...lifecycle };
  }

  // Node: Socket.IO attaches directly to the node:http.Server (srvx
  // `server.node.server`) and owns the HTTP `upgrade` event. The `route` is a
  // guard — it is never mounted on Node, but keeps the handle shape uniform.
  return {
    io,
    attach: (server) => {
      io.attach(server);
      attached = true;
    },
    // Inert on Node — never read (the `upgrade` event drives sockets). Present
    // so Bun consumers get a non-optional `websocket` with no runtime guard.
    websocket: { open: noop, message: noop, close: noop, maxPayloadLength: 0 },
    route: {
      method: 'ALL',
      path: `${path.replace(/\/+$/, '')}/*socketPath`,
      handler: () => {
        throw new Error(
          '[stitchkit] On Node, Socket.IO attaches via serveNode({ socket }) — this route is not mounted.',
        );
      },
    },
    ...lifecycle,
  };
}

/**
 * Wrap a Socket.IO handle's `websocket` as a catch-all {@link ComposedLane} for
 * {@link composeWebSocketHandlers} — when a second, raw WebSocket lane shares
 * the one `Bun.serve` websocket handler. It claims every socket no earlier
 * (raw-marker) lane matched, so the engine owns whatever the raw lanes did not
 * — and it never inspects the engine's opaque `ws.data`. Place it **last**.
 *
 * ```ts
 * const ws = composeWebSocketHandlers([
 *   webSocketLane({ match: isPcmSocket, handlers: pcmHandlers }),
 *   socketIoLane(socket.websocket),
 * ])
 * ```
 *
 * Bun-only (so is the raw-lane composition it serves).
 */
export function socketIoLane(
  websocket: SocketIOServerHandle<SocketEventMap, SocketEventMap>['websocket'],
): ComposedLane {
  return webSocketLane({
    match: (_ws: ServerWebSocket<unknown>): _ws is Parameters<typeof websocket.message>[0] =>
      true,
    handlers: websocket,
  });
}
