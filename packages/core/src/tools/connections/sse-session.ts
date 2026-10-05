import { isRecord } from '../../internal/typed';
import {
  ConnectionAuthorizationRequiredError,
  ConnectionRequestError,
  ConnectionResponseTooLargeError,
} from './errors';
import { fetchConnection } from './http';
import { type JsonRpcRequest, unwrap } from './json-rpc';
import {
  awaitConnection,
  readBoundedText,
  readConnectionErrorText,
  withConnectionDeadline,
} from './limits';
import {
  type ConnectionReadContext,
  connectionReadContext,
  type McpPhaseLimits,
  mcpOperation,
  resolveMcpLimits,
} from './operation-limits';
import { readSseFrames } from './sse-frames';
import { assertAllowedHost, assertConnectionUrl } from './ssrf';

interface SseSessionOptions {
  baseUrl: string;
  allowedHosts: ReadonlySet<string>;
  headers: Record<string, string>;
  timeoutMs: number;
  maxResponseBytes: number;
  phaseLimits?: McpPhaseLimits;
  initialContext?: ConnectionReadContext;
}

interface PendingResponse {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  context: ConnectionReadContext;
}

/** One credential-scoped legacy connection, owned and closed by one tool call. */
export class SseSession {
  private readonly controller = new AbortController();
  private readonly pending = new Map<number, PendingResponse>();
  private readonly active = new Set<ConnectionReadContext>();
  private readonly streamBytes = new WeakMap<ConnectionReadContext, number>();
  private readonly endpoint = Promise.withResolvers<string>();
  private readonly limits: McpPhaseLimits;
  private endpointContext: ConnectionReadContext;
  private endpointReady = false;
  private failure: unknown;

  constructor(
    private readonly connectionName: string,
    private readonly instanceId: string,
    private readonly options: SseSessionOptions,
  ) {
    this.limits = options.phaseLimits ?? resolveMcpLimits(options);
    this.endpointContext =
      options.initialContext ?? connectionReadContext('endpoint', this.limits);
    // Endpoint failure may precede a caller awaiting readiness.
    void this.endpoint.promise.catch(() => undefined);
    void this.open();
  }

  async ready(signal?: AbortSignal, context?: ConnectionReadContext): Promise<string> {
    if (context) {
      this.endpointContext = context;
      return this.waitForEndpoint(signal);
    }
    const readiness = this.endpointContext;
    return withConnectionDeadline(this.connectionName, readiness, signal, (scoped) =>
      this.waitForEndpoint(scoped.signal),
    );
  }

  close(reason: unknown = new Error('MCP SSE session closed')): void {
    if (this.controller.signal.aborted) return;
    this.failure = reason;
    this.controller.abort(reason);
    this.endpoint.reject(reason);
    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
    this.active.clear();
  }

  private async waitForEndpoint(signal?: AbortSignal): Promise<string> {
    const onAbort = () => this.close(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      signal?.throwIfAborted();
      return await awaitConnection(this.endpoint.promise, signal);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async request(
    message: JsonRpcRequest,
    token: string | undefined,
    signal?: AbortSignal,
    context?: ConnectionReadContext,
  ): Promise<unknown> {
    if (context) return this.requestWithin(message, token, context, signal);
    const operation = connectionReadContext(mcpOperation(message.method), this.limits);
    return withConnectionDeadline(this.connectionName, operation, signal, (scoped) =>
      this.requestWithin(message, token, scoped, scoped.signal),
    );
  }

  private async requestWithin(
    message: JsonRpcRequest,
    token: string | undefined,
    context: ConnectionReadContext,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const abort = () => this.close(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      signal?.throwIfAborted();
      if (this.controller.signal.aborted) throw this.failure;
      const endpoint = await awaitConnection(this.endpoint.promise, signal);
      const response = Promise.withResolvers<unknown>();
      void response.promise.catch(() => undefined);
      this.active.add(context);
      if (message.id !== undefined) this.pending.set(message.id, { ...response, context });
      const post = await fetchConnection(
        endpoint,
        {
          method: 'POST',
          headers: {
            ...this.options.headers,
            'content-type': 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(message),
          signal,
        },
        this.options.allowedHosts,
        this.connectionName,
      );
      await this.assertStatus(post, context);
      await readBoundedText(post, context.maxResponseBytes, this.connectionName, context);
      return message.id === undefined
        ? undefined
        : await awaitConnection(response.promise, signal);
    } finally {
      if (message.id !== undefined) this.pending.delete(message.id);
      this.active.delete(context);
      signal?.removeEventListener('abort', abort);
    }
  }

  private async assertStatus(
    response: Response,
    context: ConnectionReadContext,
  ): Promise<void> {
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
  }

  private currentContext(): ConnectionReadContext {
    if (!this.endpointReady) return this.endpointContext;
    let selected: ConnectionReadContext | undefined;
    for (const context of this.active) {
      if (!selected || context.maxResponseBytes < selected.maxResponseBytes)
        selected = context;
    }
    return selected ?? connectionReadContext('endpoint', this.limits);
  }

  /** Wrong-id frames and comments still consume every active operation's read budget. */
  private observeChunk(bytes: number): void {
    const active = this.endpointReady ? this.active : new Set([this.endpointContext]);
    for (const context of active) {
      context.observedReadBytes += bytes;
      const total = (this.streamBytes.get(context) ?? 0) + bytes;
      this.streamBytes.set(context, total);
      if (total > context.maxResponseBytes) {
        throw new ConnectionResponseTooLargeError(
          this.connectionName,
          context.maxResponseBytes,
          { ...context, observedReadBytes: total },
        );
      }
    }
  }

  private async open(): Promise<void> {
    try {
      const response = await fetchConnection(
        this.options.baseUrl,
        {
          method: 'GET',
          headers: { ...this.options.headers, accept: 'text/event-stream' },
          signal: this.controller.signal,
        },
        this.options.allowedHosts,
        this.connectionName,
      );
      await this.assertStatus(response, this.endpointContext);
      for await (const frame of readSseFrames(
        response,
        this.options.maxResponseBytes,
        this.connectionName,
        {
          signal: this.controller.signal,
          currentContext: () => this.currentContext(),
          onChunk: (bytes) => this.observeChunk(bytes),
        },
      )) {
        if (frame.event === 'endpoint') {
          const url = assertConnectionUrl(
            new URL(frame.data, this.options.baseUrl).toString(),
            this.connectionName,
          );
          assertAllowedHost(url, this.options.allowedHosts, this.connectionName);
          this.endpointReady = true;
          this.endpoint.resolve(url.toString());
        } else if (frame.event === 'message' && frame.data) {
          const message: unknown = JSON.parse(frame.data);
          if (!isRecord(message) || typeof message.id !== 'number') continue;
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          try {
            pending.resolve(unwrap(message, message.id, this.connectionName));
          } catch (error) {
            pending.reject(error);
          }
          this.pending.delete(message.id);
        }
      }
      this.close(new Error('MCP SSE stream ended'));
    } catch (error) {
      this.close(error);
    }
  }
}
