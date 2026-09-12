import { isRecord } from '../../internal/typed';
import { ConnectionAuthorizationRequiredError, ConnectionRequestError } from './errors';
import { fetchConnection } from './http';
import { type JsonRpcRequest, unwrap } from './json-rpc';
import { readBoundedText, withConnectionDeadline } from './limits';
import { readSseFrames } from './sse-frames';
import { SseSession } from './sse-session';
import { assertAllowedHost } from './ssrf';

/**
 * Minimal MCP client over the raw wire, on the global `fetch` — no peer SDK.
 *
 * Streamable HTTP is the primary transport: one `POST` per JSON-RPC message
 * carrying both `application/json` and `text/event-stream` in `Accept`, with a
 * `Mcp-Session-Id` echo after `initialize`. Legacy HTTP+SSE is the fallback and
 * only fires on `400`, `404` or `405`; every other status (auth, network, `5xx`)
 * is surfaced unchanged so a caller can tell a broken endpoint from a
 * wrong-transport one.
 */

export interface McpTransportConfig {
  url: string;
  headers?: Record<string, string>;
}

export interface McpHttpClientOptions {
  transport: McpTransportConfig;
  /** The host fence built from the connection URL and its `allowHosts`. */
  allowedHosts: ReadonlySet<string>;
  timeoutMs: number;
  maxResponseBytes: number;
}

/** Statuses that mean "this endpoint is not Streamable HTTP" — never "auth failed". */
const FALLBACK_STATUSES = new Set([400, 404, 405]);

const PROTOCOL_VERSION = '2024-11-05';

type TransportMode = 'streamable' | 'sse';

export class McpHttpClient {
  private mode: TransportMode = 'streamable';
  private sessionId: string | undefined;
  private protocolVersion: string | undefined;
  private nextId = 1;
  private initialized = false;
  private sse: SseSession | undefined;

  constructor(
    private readonly connectionName: string,
    private readonly instanceId: string,
    private readonly options: McpHttpClientOptions,
  ) {}

  /** Forget the session so the next call starts a fresh handshake. */
  teardown(): void {
    this.initialized = false;
    this.sessionId = undefined;
    this.sse?.close();
    this.sse = undefined;
    this.mode = 'streamable';
  }

  async initialize(token: string | undefined, signal?: AbortSignal): Promise<void> {
    if (this.initialized) return;
    const result = await this.request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'stitchkit', version: '0.0.0' },
      },
      token,
      signal,
    );
    if (isRecord(result) && typeof result.protocolVersion === 'string') {
      this.protocolVersion = result.protocolVersion;
    }
    this.initialized = true;
    try {
      await this.dispatch(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        token,
        signal,
      );
    } catch {
      // The spec makes this best-effort; a server that ignores it still works.
    }
  }

  request(
    method: string,
    params: unknown,
    token: string | undefined,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.dispatch({ jsonrpc: '2.0', id: this.nextId++, method, params }, token, signal);
  }

  private async dispatch(
    message: JsonRpcRequest,
    token: string | undefined,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.mode === 'sse') return this.sseRequest(message, token, signal);
    try {
      return await this.streamableRequest(message, token, signal);
    } catch (error) {
      if (error instanceof ConnectionRequestError && FALLBACK_STATUSES.has(error.status)) {
        await this.openSse(token, signal);
        this.mode = 'sse';
        return this.sseRequest(message, token, signal);
      }
      throw error;
    }
  }

  private streamableRequest(
    message: JsonRpcRequest,
    token: string | undefined,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const target = new URL(this.options.transport.url);
    assertAllowedHost(target, this.options.allowedHosts, this.connectionName);
    return withConnectionDeadline(
      this.connectionName,
      this.options.timeoutMs,
      signal,
      async (deadline) => {
        const response = await fetchConnection(
          target,
          {
            method: 'POST',
            headers: this.headers(token),
            body: JSON.stringify(message),
            signal: deadline,
          },
          this.options.allowedHosts,
          this.connectionName,
        );
        if (response.status === 401) {
          throw new ConnectionAuthorizationRequiredError(this.connectionName, this.instanceId);
        }
        if (!response.ok) {
          throw new ConnectionRequestError(
            this.connectionName,
            response.status,
            await this.safeText(response),
          );
        }
        const session = response.headers.get('mcp-session-id');
        if (session) this.sessionId = session;
        if (message.id === undefined) {
          await response.body?.cancel();
          return undefined;
        }
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('text/event-stream')) {
          for await (const frame of readSseFrames(
            response,
            this.options.maxResponseBytes,
            this.connectionName,
            true,
          )) {
            if (!frame.data) continue;
            const payload: unknown = JSON.parse(frame.data);
            if (isRecord(payload) && payload.id === message.id)
              return unwrap(payload, message.id, this.connectionName);
          }
          throw new Error('MCP stream ended without a response');
        }
        const text = await readBoundedText(
          response,
          this.options.maxResponseBytes,
          this.connectionName,
        );
        let payload: unknown;
        try {
          payload = JSON.parse(text);
        } catch {
          throw new Error(`MCP response from "${this.connectionName}" was not JSON`);
        }
        return unwrap(payload, message.id, this.connectionName);
      },
    );
  }

  private headers(token: string | undefined): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...this.options.transport.headers,
    };
    if (token) headers.authorization = `Bearer ${token}`;
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    if (this.protocolVersion) headers['mcp-protocol-version'] = this.protocolVersion;
    return headers;
  }

  private async openSse(token: string | undefined, signal?: AbortSignal): Promise<void> {
    this.sse?.close();
    this.sse = new SseSession(this.connectionName, this.instanceId, {
      baseUrl: this.options.transport.url,
      allowedHosts: this.options.allowedHosts,
      headers: this.headers(token),
      timeoutMs: this.options.timeoutMs,
      maxResponseBytes: this.options.maxResponseBytes,
    });
    await this.sse.ready(signal);
  }

  private async sseRequest(
    message: JsonRpcRequest,
    token: string | undefined,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.sse) await this.openSse(token, signal);
    const session = this.sse;
    if (!session) throw new Error('MCP SSE session failed to open');
    return session.request(message, token, signal);
  }

  private async safeText(response: Response): Promise<string> {
    try {
      return (
        await readBoundedText(response, this.options.maxResponseBytes, this.connectionName)
      ).slice(0, 512);
    } catch {
      return '';
    }
  }
}
