/** Runtime-neutral Socket.IO configuration shared by Bun and Node adapters. */
import type { ServerOptions, Socket } from 'socket.io';
import type { z } from 'zod';

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
  /** CORS — the browser origin(s) allowed to open a socket. */
  cors: { origin: string | string[]; credentials?: boolean };
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
}
