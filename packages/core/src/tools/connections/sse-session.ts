import { isRecord } from '../../internal/typed';
import { ConnectionAuthorizationRequiredError, ConnectionRequestError } from './errors';
import { fetchConnection } from './http';
import { type JsonRpcRequest, unwrap } from './json-rpc';
import { withConnectionDeadline } from './limits';
import { readSseFrames } from './sse-frames';
import { assertAllowedHost, assertConnectionUrl } from './ssrf';

interface SseSessionOptions {
  baseUrl: string;
  allowedHosts: ReadonlySet<string>;
  headers: Record<string, string>;
  timeoutMs: number;
  maxResponseBytes: number;
}

/** One credential-scoped legacy connection, owned and closed by one tool call. */
export class SseSession {
  private readonly controller = new AbortController();
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >();
  private readonly endpoint = Promise.withResolvers<string>();
  private failure: unknown;

  constructor(
    private readonly connectionName: string,
    private readonly instanceId: string,
    private readonly options: SseSessionOptions,
  ) {
    // Endpoint failure may precede a caller awaiting readiness.
    void this.endpoint.promise.catch(() => undefined);
    void this.open();
  }

  async ready(signal?: AbortSignal): Promise<string> {
    return withConnectionDeadline(
      this.connectionName,
      this.options.timeoutMs,
      signal,
      async (deadline) => {
        const onAbort = () => this.close(deadline.reason);
        deadline.addEventListener('abort', onAbort, { once: true });
        try {
          deadline.throwIfAborted();
          return await this.endpoint.promise;
        } finally {
          deadline.removeEventListener('abort', onAbort);
        }
      },
    );
  }

  close(reason: unknown = new Error('MCP SSE session closed')): void {
    this.failure = reason;
    this.controller.abort(reason);
    this.endpoint.reject(reason);
    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
  }

  async request(
    message: JsonRpcRequest,
    token: string | undefined,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return withConnectionDeadline(
      this.connectionName,
      this.options.timeoutMs,
      signal,
      async (deadline) => {
        const abort = () => this.close(deadline.reason);
        deadline.addEventListener('abort', abort, { once: true });
        try {
          deadline.throwIfAborted();
          if (this.controller.signal.aborted) throw this.failure;
          const endpoint = await this.endpoint.promise;
          const response = Promise.withResolvers<unknown>();
          void response.promise.catch(() => undefined);
          if (message.id !== undefined) this.pending.set(message.id, response);
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
              signal: deadline,
            },
            this.options.allowedHosts,
            this.connectionName,
          );
          this.assertStatus(post);
          await post.body?.cancel();
          return message.id === undefined ? undefined : await response.promise;
        } finally {
          if (message.id !== undefined) this.pending.delete(message.id);
          deadline.removeEventListener('abort', abort);
        }
      },
    );
  }

  private assertStatus(response: Response): void {
    if (response.status === 401)
      throw new ConnectionAuthorizationRequiredError(this.connectionName, this.instanceId);
    if (!response.ok)
      throw new ConnectionRequestError(this.connectionName, response.status, '');
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
      this.assertStatus(response);
      for await (const frame of readSseFrames(
        response,
        this.options.maxResponseBytes,
        this.connectionName,
      )) {
        if (frame.event === 'endpoint') {
          const url = assertConnectionUrl(
            new URL(frame.data, this.options.baseUrl).toString(),
            this.connectionName,
          );
          assertAllowedHost(url, this.options.allowedHosts, this.connectionName);
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
