/**
 * Compose one Bun `websocket` handler from several independent lanes.
 *
 * `Bun.serve` accepts a **single** `websocket` handler. `@socket.io/bun-engine`
 * claims it (via `createSocketIOServer().websocket`). A project that also wants a
 * second, truly-raw binary WebSocket lane on the same server — a high-frequency
 * stream (PCM, video, large transfers) with no Socket.IO framing — has to
 * hand-compose that one handler: route each socket to the engine or to its own
 * raw handlers.
 *
 * The fragile part is the discriminator. Routing *to* Socket.IO means asking
 * "is this an engine socket?", which forces inspecting the engine's opaque
 * `ws.data` — a brittle guard, hard to keep cast-free. The fix here is to invert
 * it: a raw lane stamps **its own** marker onto `ws.data` at upgrade time and is
 * matched positively; Socket.IO is simply the **fallback** lane (matched last,
 * `() => true`). The engine's data is therefore never inspected.
 *
 * Cast-free: each lane carries a type-predicate `match` that narrows
 * `ServerWebSocket<unknown>` to its own data type, so the typed handlers are
 * invoked without a single `as`.
 *
 * Bun-only. On Node, Socket.IO drives sockets through the `node:http.Server`
 * `upgrade` event (`serveNode({ socket })`) — a different model, and a raw lane
 * there would be a separate upgrade handler, not this composition.
 */
import type { ServerWebSocket, WebSocketHandler } from 'bun';

/** One lane of a composed handler — a typed slice of the single Bun websocket. */
export interface WebSocketLane<TData> {
  /**
   * Type-predicate selecting the sockets this lane owns — usually a check on
   * `ws.data` set at upgrade. As a predicate it narrows `ws` to the lane's data
   * type, which is what keeps the handler call cast-free.
   */
  match: (ws: ServerWebSocket<unknown>) => ws is ServerWebSocket<TData>;
  /** Handlers for this lane's sockets — `ws.data` is fully typed as `TData`. */
  handlers: WebSocketHandler<TData>;
}

/** A lane already bridged to the loose (`unknown`) data type, ready to compose. */
export interface ComposedLane {
  match: (ws: ServerWebSocket<unknown>) => boolean;
  handlers: WebSocketHandler<unknown>;
}

/**
 * Server-wide WebSocket tuning for the composed handler. Bun applies these to
 * every socket on the server (they cannot be per-lane), so set them to the most
 * permissive value across lanes — a raw binary lane typically needs a larger
 * `maxPayloadLength` than Socket.IO's default (its `maxHttpBufferSize`, 1 MB).
 */
export type WebSocketComposeConfig = Omit<
  WebSocketHandler<unknown>,
  'open' | 'message' | 'close' | 'drain' | 'ping' | 'pong'
>;

/**
 * Build a `ComposedLane` from typed handlers. Each callback is wrapped so it
 * fires only for sockets the lane's `match` predicate claims — narrowing `ws`
 * to `ServerWebSocket<TData>` for the typed handler. This is the one bridge from
 * Bun's single untyped `websocket` to a typed, per-lane handler, and it holds
 * no casts.
 */
export function webSocketLane<TData>(lane: WebSocketLane<TData>): ComposedLane {
  const { match, handlers } = lane;
  return {
    match,
    handlers: {
      message(ws, message) {
        if (match(ws)) handlers.message(ws, message);
      },
      open(ws) {
        if (match(ws)) handlers.open?.(ws);
      },
      close(ws, code, reason) {
        if (match(ws)) handlers.close?.(ws, code, reason);
      },
      drain(ws) {
        if (match(ws)) handlers.drain?.(ws);
      },
      ping(ws, data) {
        if (match(ws)) handlers.ping?.(ws, data);
      },
      pong(ws, data) {
        if (match(ws)) handlers.pong?.(ws, data);
      },
    },
  };
}

/**
 * Compose lanes into the single `websocket` handler for `createServer`. On each
 * callback the first lane whose `match` claims the socket handles it — so put
 * specific lanes (raw markers) first and the catch-all (Socket.IO,
 * `socketIoLane`) last. `config` carries the server-wide tuning.
 *
 * ```ts
 * const ws = composeWebSocketHandlers(
 *   [webSocketLane({ match: isPcmSocket, handlers: pcmHandlers }), socketIoLane(socket.websocket)],
 *   { maxPayloadLength: 16 * 1024 * 1024 },
 * )
 * createServer({ socket, websocket: ws, rawRoutes: [pcmUpgradeRoute] })
 * ```
 */
export function composeWebSocketHandlers(
  lanes: ComposedLane[],
  config?: WebSocketComposeConfig,
): WebSocketHandler<unknown> {
  const pick = (ws: ServerWebSocket<unknown>): ComposedLane | undefined =>
    lanes.find((lane) => lane.match(ws));

  return {
    ...config,
    message(ws, message) {
      pick(ws)?.handlers.message(ws, message);
    },
    open(ws) {
      pick(ws)?.handlers.open?.(ws);
    },
    close(ws, code, reason) {
      pick(ws)?.handlers.close?.(ws, code, reason);
    },
    drain(ws) {
      pick(ws)?.handlers.drain?.(ws);
    },
    ping(ws, data) {
      pick(ws)?.handlers.ping?.(ws, data);
    },
    pong(ws, data) {
      pick(ws)?.handlers.pong?.(ws, data);
    },
  };
}
