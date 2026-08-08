import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type EventId,
  type EventStore,
  type StreamId,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import {
  buildMcpServer,
  buildMcpServerFromPrepared,
  type McpServerBuildConfig,
  type McpSurfaceRegistry,
  prepareMcpServerSurface,
} from './mcp';
import { type ProtectedResourceConfig, wwwAuthenticateHeader } from './oauth-metadata';

// ─── In-memory event store (SSE resumability) ───────────────────────────────

const EVENT_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

/** Hard caps — a burst between sweeps must not grow memory without bound. */
const MAX_EVENTS = 10_000;
const MAX_SESSIONS = 1_000;

interface StoredEvent {
  streamId: string;
  message: JSONRPCMessage;
  timestamp: number;
}

/**
 * Event store for Streamable-HTTP SSE resumability — if a client loses its
 * SSE stream it reconnects with `Last-Event-ID` and the SDK replays. Capped at
 * `MAX_EVENTS` (oldest-first eviction) on top of the TTL sweep.
 */
class InMemoryEventStore implements EventStore {
  private events = new Map<string, StoredEvent>();
  private counter = 0;

  async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    const eventId = String(++this.counter);
    this.events.set(eventId, { streamId, message, timestamp: Date.now() });
    // Evict the oldest event once the cap is hit — the Map keeps insertion
    // order, so the first key is the oldest.
    if (this.events.size > MAX_EVENTS) {
      const oldest = this.events.keys().next().value;
      if (oldest !== undefined) this.events.delete(oldest);
    }
    return eventId;
  }

  async getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    return this.events.get(eventId)?.streamId;
  }

  async replayEventsAfter(
    lastEventId: EventId,
    { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> },
  ): Promise<StreamId> {
    // Replay only the stream the client is resuming — never another session's.
    const anchor = this.events.get(lastEventId);
    if (!anchor) return '';
    const lastIdNum = Number(lastEventId);
    for (const [eventId, event] of this.events) {
      if (event.streamId === anchor.streamId && Number(eventId) > lastIdNum) {
        await send(eventId, event.message);
      }
    }
    return anchor.streamId;
  }

  cleanup(): void {
    const cutoff = Date.now() - EVENT_TTL_MS;
    for (const [eventId, event] of this.events) {
      if (event.timestamp < cutoff) this.events.delete(eventId);
    }
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface McpHttpConfig<TAuth> {
  /** Resolve an incoming request to an identity. Return `null` → 401. */
  auth: (req: Request) => TAuth | null | Promise<TAuth | null>;
  /**
   * OAuth 2.0 Protected Resource metadata (RFC 9728). When set, a `401` carries
   * a `WWW-Authenticate: Bearer resource_metadata="…"` header so an MCP client
   * can discover the authorization server. Serve the matching metadata document
   * with `oauthProtectedResourceRoute(protectedResource)`.
   */
  protectedResource?: ProtectedResourceConfig;
  /** HTTP transport state. Default `'stateless'`; opt into `'stateful'` only
   *  for cross-request progress, server push or resumable SSE sessions. */
  sessionMode?: McpSessionMode;
}

export type McpHandlerConfig<
  TAuth,
  TSurfaces extends McpSurfaceRegistry = McpSurfaceRegistry,
> = McpServerBuildConfig<TAuth, TSurfaces> & McpHttpConfig<TAuth>;

export type McpSessionMode = 'stateful' | 'stateless';

interface SessionData {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  lastSeen: number;
}

function jsonRpcError(
  code: number,
  message: string,
  status: number,
  headers?: Record<string, string>,
): Response {
  return Response.json(
    { jsonrpc: '2.0', error: { code, message }, id: null },
    { status, headers },
  );
}

/**
 * Build a Streamable-HTTP MCP request handler (`Request → Response`).
 *
 * Owns the MCP server/transport lifecycle — and, only in explicit stateful
 * mode, the SSE event/session stores — so the consuming app never imports the
 * SDK itself. The app only declares WHAT to expose:
 * how to authenticate and which contract services. MCP tools come from
 * contracts; multimodal operations are declared as framework `runtimeTools`.
 *
 * The server itself is built by the transport-neutral `buildMcpServer` — the
 * same core used by `createStdioMcpServer`.
 *
 * Mount the returned handler in your server's fetch router (e.g. under `/mcp`).
 */
export function createMcpHandler<
  TAuth,
  const TSurfaces extends McpSurfaceRegistry = McpSurfaceRegistry,
>(config: McpHandlerConfig<TAuth, TSurfaces>): (req: Request) => Promise<Response> {
  let buildServer: (auth: TAuth) => McpServer;
  const preparation = {
    logger: config.logger,
    extend: config.extend,
    flattenUnionInput: config.flattenUnionInput,
    schemaValidation: config.schemaValidation,
  };
  if (config.surfaces && config.selectSurface) {
    const selectSurface = config.selectSurface;
    const preparedByKey = new Map<string, ReturnType<typeof prepareMcpServerSurface>>();
    const preparedBySurface = new WeakMap<
      object,
      ReturnType<typeof prepareMcpServerSurface>
    >();
    for (const key in config.surfaces) {
      if (!Object.hasOwn(config.surfaces, key)) continue;
      const surface = config.surfaces[key];
      if (!surface) continue;
      const existing = preparedBySurface.get(surface);
      const prepared = existing ?? prepareMcpServerSurface(surface, preparation);
      if (!existing) preparedBySurface.set(surface, prepared);
      preparedByKey.set(key, prepared);
    }
    buildServer = (auth) => {
      const key = selectSurface(auth);
      const prepared = preparedByKey.get(key);
      if (!prepared) throw new Error(`[stitchkit] Unknown MCP surface "${key}"`);
      return buildMcpServerFromPrepared(config, auth, prepared);
    };
  } else if (
    config.services &&
    typeof config.services !== 'function' &&
    typeof config.runtimeTools !== 'function'
  ) {
    // A deterministic direct surface is prepared once; every session/request
    // still gets a fresh server and runtime over the immutable descriptors.
    const prepared = prepareMcpServerSurface(
      { services: config.services, runtimeTools: config.runtimeTools },
      preparation,
    );
    buildServer = (auth) => buildMcpServerFromPrepared(config, auth, prepared);
  } else {
    // Truly identity-dependent factories remain uncached by design: an
    // arbitrary identity is not a bounded cache key.
    buildServer = (auth) => buildMcpServer(config, auth);
  }

  /** RFC 9728 §5.1 401 — points the client at the OAuth resource metadata. */
  const unauthorized = (): Response => {
    const headers = config.protectedResource
      ? { 'WWW-Authenticate': wwwAuthenticateHeader(config.protectedResource.resource) }
      : undefined;
    return jsonRpcError(-32001, 'Authorization required', 401, headers);
  };

  // ── Stateless mode ─────────────────────────────────────────────────────────
  // A fresh transport + server per request, no session store. A restart never
  // invalidates a client (no `404 Session not found`). The SDK requires a new
  // transport per request in stateless mode — reuse collides message ids.
  if ((config.sessionMode ?? 'stateless') === 'stateless') {
    return async (req: Request): Promise<Response> => {
      const auth = await config.auth(req);
      if (!auth) return unauthorized();
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        // A complete JSON response (not a held-open SSE stream) — the request is
        // self-contained, so the transport can be discarded once it returns.
        enableJsonResponse: true,
      });
      const server = buildServer(auth);
      await server.connect(transport);
      return transport.handleRequest(req);
    };
  }

  // ── Stateful mode (session store + SSE event store) ─────────────────────────
  const eventStore = new InMemoryEventStore();
  const sessions = new Map<string, SessionData>();

  const closeTransport = (transport: WebStandardStreamableHTTPServerTransport): void => {
    transport.close().catch((err) => {
      console.error('[stitchkit] MCP transport close failed:', err);
    });
  };

  // Periodic sweep — expire SSE events and idle sessions. Must not by itself
  // keep the process alive.
  setInterval(() => {
    eventStore.cleanup();
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, session] of sessions) {
      if (session.lastSeen < cutoff) {
        sessions.delete(id);
        closeTransport(session.transport);
      }
    }
  }, SWEEP_INTERVAL_MS).unref();

  return async (req: Request): Promise<Response> => {
    const auth = await config.auth(req);
    if (!auth) return unauthorized();

    const sessionId = req.headers.get('mcp-session-id');
    if (sessionId) {
      const existing = sessions.get(sessionId);
      // A session id the server does not know is expired or forged — never
      // mint a server for a client-supplied id.
      if (!existing) {
        return jsonRpcError(-32001, 'Session not found', 404);
      }
      existing.lastSeen = Date.now();
      // SSE reconnect: the SDK allows one standalone SSE per session.
      if (req.method === 'GET') {
        existing.transport.closeStandaloneSSEStream();
      }
      return existing.transport.handleRequest(req);
    }

    // No session id → a fresh session; the id is always server-generated.
    // Cap concurrent sessions — evict the least-recently-seen one on overflow
    // so a session-minting flood cannot exhaust memory.
    if (sessions.size >= MAX_SESSIONS) {
      let oldestId: string | undefined;
      let oldestSeen = Number.POSITIVE_INFINITY;
      for (const [id, session] of sessions) {
        if (session.lastSeen < oldestSeen) {
          oldestSeen = session.lastSeen;
          oldestId = id;
        }
      }
      if (oldestId !== undefined) {
        const evicted = sessions.get(oldestId);
        sessions.delete(oldestId);
        if (evicted) closeTransport(evicted.transport);
      }
    }

    const newSessionId = randomUUID();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
      eventStore,
    });
    const server = buildServer(auth);

    sessions.set(newSessionId, { transport, server, lastSeen: Date.now() });
    transport.onclose = () => {
      sessions.delete(newSessionId);
    };

    await server.connect(transport);
    return transport.handleRequest(req);
  };
}
