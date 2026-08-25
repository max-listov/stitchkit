/** Runtime-neutral Socket.IO configuration shared by Bun and Node adapters. */
import type { ServerOptions, Socket, Server as SocketIOServer } from 'socket.io';
import type { z } from 'zod';

/**
 * How this project loads its optional Socket.IO peers.
 *
 * Stitchkit resolves them through a variable rather than a literal
 * `import('socket.io')`, deliberately: a consumer bundling an unrelated
 * `stitchkit/server` export must not have to resolve peers it never uses, and
 * `@socket.io/bun-engine` is Bun-only, so a top-level value import would break
 * the barrel on Node before anything reached the socket code.
 *
 * The cost was that there was no way BACK. A consumer that uses this adapter and
 * ships one self-contained file to a machine with no `node_modules` — and often
 * no network — could not tell the framework so: a bundler cannot follow
 * `import(SOME_VARIABLE)`, so the package never entered the artifact and the
 * failure arrived at START-UP rather than at build time. The only workaround was
 * patching stitchkit's built `dist` to replace the variable with a literal,
 * which broke whenever the internal layout moved.
 *
 * Passing a loader puts the literal in the CONSUMER's source, where their own
 * bundler sees it statically and includes the package. The default stays lazy,
 * so nothing changes for anyone who does not pass one:
 *
 * ```ts
 * createSocketIOServer({
 *   ...config,
 *   peers: {
 *     server: () => import('socket.io'),
 *     bunEngine: () => import('@socket.io/bun-engine'),
 *   },
 * })
 * ```
 *
 * A function rather than an already-resolved module, so laziness and
 * initialisation order are unchanged: nothing is loaded until the adapter needs
 * it, and on Node the Bun engine is never asked for at all.
 */
export interface SocketIOPeerLoaders {
  /** `() => import('socket.io')`. */
  server?: () => Promise<{ Server: typeof SocketIOServer }>;
  /**
   * `() => import('@socket.io/bun-engine')`. Never called off Bun.
   *
   * Typed as `unknown` and shape-checked where it is used, because this module
   * is the RUNTIME-NEUTRAL half: `stitchkit/node` re-exports it, and a
   * Bun-only type reaching a Node consumer's declarations is exactly the
   * breakage the split exists to prevent — the consumer-lane peer budget
   * refuses it. The loader is still written the obvious way; only the type of
   * what it returns is checked at the boundary rather than here.
   */
  bunEngine?: () => Promise<unknown>;
}

/** Runtime-neutral Engine.IO handshake policy, evaluated before shutdown admission. */
export type SocketIORequestPolicy = (request: Request) => boolean | Promise<boolean>;

/**
 * Typed identity gate for the Socket.IO handshake. `schema` validates
 * `socket.handshake.auth` (the structured channel — `query` values are strings
 * on the wire); an optional `verify` turns the parsed payload into the
 * connection identity. Returning `null` or throwing rejects the handshake
 * **before** the connection handler and before any event validation; the
 * accepted identity is written to `socket.data`, typed end-to-end through
 * `createSocketIOServer` and `bindRealtimeServer`.
 *
 * A rejected handshake is terminal for socket.io-client — it does **not**
 * retry (unlike a transport-level denial). The stitchkit client surfaces it
 * via `onConnectError` with `terminal: true`; recovery is an explicit
 * `connect()`, which re-reads a function-form `auth`.
 */
export interface SocketIOHandshakeConfig<TParsed, TData = TParsed> {
  /** Zod schema for `socket.handshake.auth`. */
  schema: z.ZodType<TParsed>;
  /**
   * Turn the schema-validated payload into the connection identity (may be
   * async — the wrapper awaits it safely; socket.io itself would leak an
   * unhandled rejection from a raw async middleware). Return `null` or throw
   * to reject; a thrown error is logged server-side and the peer sees only
   * the generic `handshake rejected` — raw error text never crosses to an
   * unauthenticated client. When omitted, the parsed payload itself is the
   * identity (when passing `TData` explicitly with `TData ≠ TParsed`,
   * `verify` is therefore mandatory — without it the runtime stores the
   * schema output). The `schema` must be synchronous (no async
   * refine/transform).
   */
  verify?: (
    parsed: TParsed,
    context: { handshake: Socket['handshake'] },
  ) => TData | null | Promise<TData | null>;
}

export interface SocketIOServerConfig<TParsed = any, TData = TParsed> {
  /**
   * CORS — the browser origin(s) allowed to open a socket.
   *
   * Optional: omit it when the browser reaches this server on its own origin.
   * Socket.IO then emits no CORS headers, which is same-origin only — the safe
   * default, and one a repository can hold without knowing where it will run.
   * A cross-origin browser needs the allow-list and must pass it.
   */
  cors?: { origin: string | string[]; credentials?: boolean };
  /** Socket.IO endpoint path. Default `/socket.io/`. */
  path?: string;
  /** Transports offered to clients; the runtime supplies its own default. */
  transports?: Array<'websocket' | 'polling'>;
  /** Heartbeat: ms without a pong before the connection is dropped. */
  pingTimeout?: number;
  /** Heartbeat: ms between pings. */
  pingInterval?: number;
  /** Runtime-neutral policy for accepting a new Engine.IO handshake. */
  allowRequest?: SocketIORequestPolicy;
  /**
   * Typed identity gate — Zod-validate the handshake and put the result into
   * `socket.data`. Registered as the **first** `io.use()` middleware, so app
   * middlewares added later see the typed identity already in place. Type
   * inference works on calls without explicit event generics (the
   * `bindRealtimeServer` lane); with explicit generics, pass the identity
   * types explicitly: `createSocketIOServer<S, C, Parsed, Data>`.
   */
  handshake?: SocketIOHandshakeConfig<TParsed, TData>;
  /** Typed Socket.IO options not owned by this wrapper. */
  serverOptions?: Omit<Partial<ServerOptions>, 'allowRequest'>;
  /**
   * How to load the optional Socket.IO peers. Omit it and they are resolved
   * lazily at run time, which needs them present on the machine; pass literal
   * dynamic imports and your bundler puts them inside the artifact.
   */
  peers?: SocketIOPeerLoaders;
}
