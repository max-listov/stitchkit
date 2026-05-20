import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type EventId,
  type EventStore,
  type StreamId,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { buildMcpServer, type McpServerBuildConfig } from './mcp';

// ─── In-memory event store (SSE resumability) ───────────────────────────────

const EVENT_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 60 * 1000;

interface StoredEvent {
  streamId: string;
  message: JSONRPCMessage;
  timestamp: number;
}

/**
 * Event store for Streamable-HTTP SSE resumability — if a client loses its
 * SSE stream it reconnects with `Last-Event-ID` and the SDK replays.
 */
class InMemoryEventStore implements EventStore {
  private events = new Map<string, StoredEvent>();
  private counter = 0;

  async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    const eventId = String(++this.counter);
    this.events.set(eventId, { streamId, message, timestamp: Date.now() });
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

export interface McpHandlerConfig<TAuth> extends McpServerBuildConfig<TAuth> {
  /** Resolve an incoming request to an identity. Return `null` → 401. */
  auth: (req: Request) => TAuth | null | Promise<TAuth | null>;
}

interface SessionData {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  lastSeen: number;
}

function jsonRpcError(code: number, message: string, status: number): Response {
  return Response.json({ jsonrpc: '2.0', error: { code, message }, id: null }, { status });
}

/**
 * Build a Streamable-HTTP MCP request handler (`Request → Response`).
 *
 * Owns the entire MCP server lifecycle — SSE event store, per-session
 * transports, the `McpServer` instances — so the consuming app never imports
 * `@modelcontextprotocol/sdk` itself. The app only declares WHAT to expose:
 * how to authenticate and which contract services. MCP tools come from
 * contracts; native multimodal tools attach via `nativeTools`.
 *
 * The server itself is built by the transport-neutral `buildMcpServer` — the
 * same core used by `createStdioMcpServer`.
 *
 * Mount the returned handler in your server's fetch router (e.g. under `/mcp`).
 */
export function createMcpHandler<TAuth>(
  config: McpHandlerConfig<TAuth>,
): (req: Request) => Promise<Response> {
  const eventStore = new InMemoryEventStore();
  const sessions = new Map<string, SessionData>();

  // Periodic sweep — expire SSE events and idle sessions. Must not by itself
  // keep the process alive.
  setInterval(() => {
    eventStore.cleanup();
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, session] of sessions) {
      if (session.lastSeen < cutoff) {
        sessions.delete(id);
        session.transport.close().catch(() => undefined);
      }
    }
  }, EVENT_TTL_MS).unref();

  return async (req: Request): Promise<Response> => {
    const auth = await config.auth(req);
    if (!auth) {
      return jsonRpcError(-32001, 'Authorization required', 401);
    }

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
    const newSessionId = randomUUID();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
      eventStore,
    });
    const server = buildMcpServer(config, auth);

    sessions.set(newSessionId, { transport, server, lastSeen: Date.now() });
    transport.onclose = () => {
      sessions.delete(newSessionId);
    };

    await server.connect(transport);
    return transport.handleRequest(req);
  };
}
