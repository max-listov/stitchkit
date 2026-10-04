import { isRecord } from '../../internal/typed';
import {
  ConnectionAuthorizationRequiredError,
  ConnectionRequestError,
  ConnectionResponseTooLargeError,
  ConnectionTimeoutError,
} from './errors';
import { fetchConnection } from './http';
import { type JsonRpcRequest, unwrap } from './json-rpc';
import { readBoundedText, readConnectionErrorText, withConnectionDeadline } from './limits';
import {
  type ConnectionReadContext,
  connectionReadContext,
  type McpPhaseLimits,
  mcpOperation,
  resolveMcpLimits,
} from './operation-limits';
import { readSseFrames } from './sse-frames';
import { SseSession } from './sse-session';
import { assertAllowedHost } from './ssrf';
import type { McpConnectionLimits } from './types';

/**
 * Minimal MCP client over the raw wire, on the global `fetch` — no peer SDK.
 *
 * Streamable HTTP is the primary transport: one `POST` per JSON-RPC message
 * carrying both `application/json` and `text/event-stream` in `Accept`, with a
 * `Mcp-Session-Id` echo after `initialize`. Legacy HTTP+SSE is the fallback and
 * negotiates only the initial `initialize`, on `400`, `404` or `405`. An
 * operation already dispatched to a negotiated transport is never replayed.
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
  limits?: McpConnectionLimits;
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
  private initialInitializePending = true;
  private sse: SseSession | undefined;
  private readonly limits: McpPhaseLimits;

  constructor(
    private readonly connectionName: string,
    private readonly instanceId: string,
    private readonly options: McpHttpClientOptions,
  ) {
    this.limits = resolveMcpLimits(options);
  }

  /** Forget the session so the next call starts a fresh handshake. */
  teardown(): void {
    this.initialized = false;
    this.initialInitializePending = true;
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
    try {
      await this.dispatch(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        token,
        signal,
      );
    } catch (error) {
      signal?.throwIfAborted();
      if (
        error instanceof ConnectionTimeoutError ||
        error instanceof ConnectionResponseTooLargeError
      ) {
        throw error;
      }
      // A server may ignore the notification; declared bounds and cancellation still apply.
    }
    this.initialized = true;
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
    const context = connectionReadContext(mcpOperation(message.method), this.limits);
    const negotiate = message.method === 'initialize' && this.initialInitializePending;
    if (message.method === 'initialize') this.initialInitializePending = false;
    return withConnectionDeadline(
      this.connectionName,
      context.timeoutMs,
      signal,
      async () => {
        if (this.mode === 'sse') return this.sseRequest(message, token, context);
        try {
          return await this.streamableRequest(message, token, context);
        } catch (error) {
          context.signal?.throwIfAborted();
          if (
            negotiate &&
            error instanceof ConnectionRequestError &&
            FALLBACK_STATUSES.has(error.status)
          ) {
            await this.openSse(token, context);
            this.mode = 'sse';
            return this.sseRequest(message, token, context);
          }
          throw error;
        }
      },
      context,
    );
  }

  private async streamableRequest(
    message: JsonRpcRequest,
    token: string | undefined,
    context: ConnectionReadContext,
  ): Promise<unknown> {
    const target = new URL(this.options.transport.url);
    assertAllowedHost(target, this.options.allowedHosts, this.connectionName);
    context.signal?.throwIfAborted();
    const response = await fetchConnection(
      target,
      {
        method: 'POST',
        headers: this.headers(token),
        body: JSON.stringify(message),
        signal: context.signal,
      },
      this.options.allowedHosts,
      this.connectionName,
    );
    if (response.status === 401) {
      void response.body?.cancel().catch(() => undefined);
      throw new ConnectionAuthorizationRequiredError(
        this.connectionName,
        this.instanceId,
        context,
      );
    }
    if (!response.ok) {
      throw new ConnectionRequestError(
        this.connectionName,
        response.status,
        await readConnectionErrorText(response, this.connectionName, context),
        context,
      );
    }
    const session = response.headers.get('mcp-session-id');
    if (session) this.sessionId = session;
    if (message.id === undefined) {
      await readBoundedText(response, context.maxResponseBytes, this.connectionName, context);
      return undefined;
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      for await (const frame of readSseFrames(
        response,
        context.maxResponseBytes,
        this.connectionName,
        { totalLimit: true, context },
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
      context.maxResponseBytes,
      this.connectionName,
      context,
    );
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`MCP response from "${this.connectionName}" was not JSON`);
    }
    return unwrap(payload, message.id, this.connectionName);
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

  private async openSse(
    token: string | undefined,
    context: ConnectionReadContext,
  ): Promise<void> {
    this.sse?.close();
    this.sse = new SseSession(this.connectionName, this.instanceId, {
      baseUrl: this.options.transport.url,
      allowedHosts: this.options.allowedHosts,
      headers: this.headers(token),
      timeoutMs: this.options.timeoutMs,
      maxResponseBytes: this.options.maxResponseBytes,
      phaseLimits: this.limits,
      initialContext: context,
    });
    await this.sse.ready(context.signal, context);
  }

  private async sseRequest(
    message: JsonRpcRequest,
    token: string | undefined,
    context: ConnectionReadContext,
  ): Promise<unknown> {
    if (!this.sse) await this.openSse(token, context);
    const session = this.sse;
    if (!session) throw new Error('MCP SSE session failed to open');
    return session.request(message, token, context.signal, context);
  }
}
