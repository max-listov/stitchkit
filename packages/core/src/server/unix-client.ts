import { Agent, request as httpRequest, type IncomingMessage } from 'node:http';
import type { ClientFetch } from '../browser/transport';
import { abortReason } from '../internal/abort-race';
import { assertTimerMs } from '../internal/deadline';
import { errnoOf } from '../internal/errno';
import { assertPositiveSafeInteger } from '../internal/positive-integer';
import {
  type UnixClientDeliveryState,
  UnixClientTransportError,
  unixTransportError,
} from '../internal/unix-client-error';
import {
  assertUnixSocketClientTarget,
  assertUnixSocketPathLength,
} from '../internal/unix-socket';
import {
  cloneRequestBodyBuffer,
  exceedsDeclaredResponseBytes,
  incomingResponseBody,
  incomingResponseHeaders,
  readBoundedRequestBody,
} from './unix-client-body';
import { bunUnixRequest, hasBunUnixRuntime } from './unix-client-bun';

const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_HEADERS_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CONNECTIONS = 8;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_HEADER_BYTES = 64 * 1024;

/** Whether response bytes have a finite lifetime total or only bounded buffering. */
export type UnixResponseBodyMode = 'bounded' | 'streaming';

/**
 * Unix transport configuration. Unary responses are cumulatively bounded by
 * default; a long-lived stream must opt into pull-driven streaming explicitly.
 */
export type UnixClientTransportConfig = {
  /** Absolute local socket path selected by deployment configuration. */
  socketPath: string;
  maxRequestBytes?: number;
  headersTimeoutMs?: number;
  maxHeaderBytes?: number;
  maxConnections?: number;
  /** Redirects stay on this Unix transport. Default 5. */
  maxRedirects?: number;
} & (
  | {
      responseBodyMode?: 'bounded';
      maxResponseBytes?: number;
    }
  | {
      responseBodyMode: 'streaming';
      maxResponseBytes?: never;
    }
);

export interface UnixClientTransport {
  readonly fetch: ClientFetch;
  readonly closed: boolean;
  close(): Promise<void>;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  assertPositiveSafeInteger(name, resolved);
  return resolved;
}

function nonNegativeInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return resolved;
}

function isRedirect(status: number): boolean {
  return (
    status === 301 || status === 302 || status === 303 || status === 307 || status === 308
  );
}

function redirectedRequest(
  request: Request,
  location: string,
  status: number,
  body: Uint8Array | undefined,
): Request {
  const url = new URL(location, request.url);
  const changesToGet =
    status === 303 || ((status === 301 || status === 302) && request.method === 'POST');
  const headers = new Headers(request.headers);
  if (changesToGet) {
    headers.delete('content-length');
    headers.delete('content-type');
  }
  return new Request(url, {
    method: changesToGet ? 'GET' : request.method,
    headers,
    ...(!changesToGet && body !== undefined && { body: cloneRequestBodyBuffer(body) }),
    redirect: request.redirect,
    signal: request.signal,
  });
}

interface UnixClientLimits {
  maxRequestBytes: number;
  maxResponseBytes: number | undefined;
  headersTimeoutMs: number;
  maxConnections: number;
  maxHeaderBytes: number;
  maxRedirects: number;
}

/** Validate the socket path and resolve every bound, before anything is opened. */
function resolveUnixClientLimits(config: UnixClientTransportConfig): UnixClientLimits {
  if (!config.socketPath.startsWith('/') || config.socketPath.includes('\0')) {
    throw new TypeError('socketPath must be an absolute Unix socket path');
  }
  assertUnixSocketPathLength(config.socketPath, 'createUnixClientTransport');
  if (config.responseBodyMode === 'streaming' && config.maxResponseBytes !== undefined) {
    throw new TypeError('maxResponseBytes cannot be combined with responseBodyMode streaming');
  }
  const pos = positiveInteger;
  assertTimerMs('headersTimeoutMs', config.headersTimeoutMs);
  return {
    maxRequestBytes: pos(config.maxRequestBytes, DEFAULT_MAX_BODY_BYTES, 'maxRequestBytes'),
    maxResponseBytes:
      config.responseBodyMode === 'streaming'
        ? undefined
        : pos(config.maxResponseBytes, DEFAULT_MAX_BODY_BYTES, 'maxResponseBytes'),
    headersTimeoutMs: config.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS,
    maxConnections: pos(config.maxConnections, DEFAULT_MAX_CONNECTIONS, 'maxConnections'),
    maxHeaderBytes: pos(config.maxHeaderBytes, DEFAULT_MAX_HEADER_BYTES, 'maxHeaderBytes'),
    maxRedirects: nonNegativeInteger(
      config.maxRedirects,
      DEFAULT_MAX_REDIRECTS,
      'maxRedirects',
    ),
  };
}

/**
 * Whether a redirect response is followed, returned as is, or refused. The two
 * runtime paths share this step; each only releases its own response first.
 */
function redirectStep(
  request: Request,
  status: number,
  location: string | null,
  redirectCount: number,
  maxRedirects: number,
): 'return' | 'follow' {
  if (!location || !isRedirect(status)) return 'return';
  if (request.redirect === 'error' || redirectCount >= maxRedirects) {
    throw new UnixClientTransportError(
      'UNIX_REDIRECT_REFUSED',
      redirectCount >= maxRedirects
        ? `Unix redirect limit ${maxRedirects} exceeded`
        : 'Unix request redirect mode is error',
      'response-received',
    );
  }
  return request.redirect === 'follow' ? 'follow' : 'return';
}

interface NodeUnixRequestInput {
  socketPath: string;
  url: URL;
  request: Request;
  headers: Record<string, string>;
  body: Uint8Array | undefined;
  agent: Agent;
  maxHeaderBytes: number;
  headersTimeoutMs: number;
  activeRequests: Set<() => void>;
}

/**
 * One `node:http` request over the socket, resolved at the response head. The
 * failure is classified by whether this request could have reached the server.
 */
function nodeUnixRequest(input: NodeUnixRequestInput): Promise<IncomingMessage> {
  const { request, url, headersTimeoutMs, maxHeaderBytes, activeRequests } = input;
  return new Promise<IncomingMessage>((resolve, reject) => {
    let settled = false;
    const resolveOnce = (response: IncomingMessage): void => {
      if (settled) return;
      settled = true;
      resolve(response);
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const outgoing = httpRequest(
      {
        socketPath: input.socketPath,
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers: input.headers,
        agent: input.agent,
        signal: request.signal,
        // Node's parser enforces this before exposing an IncomingMessage.
        // The limit counts the complete HTTP response head in wire bytes.
        maxHeaderSize: maxHeaderBytes,
      },
      resolveOnce,
    );
    let connected = false;
    let requestStartBytes = 0;
    outgoing.once('socket', (socket) => {
      requestStartBytes = socket.bytesWritten;
      if (!socket.connecting && !socket.destroyed) connected = true;
      else {
        socket.once('connect', () => {
          connected = true;
        });
      }
    });
    const isDispatched = (): boolean =>
      connected && (outgoing.socket?.bytesWritten ?? requestStartBytes) > requestStartBytes;
    const { socketPath } = input;
    const abortOnClose = (): void => {
      const delivery = isDispatched() ? 'possibly-dispatched' : 'not-dispatched';
      const error = unixTransportError(
        socketPath,
        'UNIX_CLIENT_CLOSED',
        'Unix client transport is closed',
        delivery,
      );
      rejectOnce(error);
      outgoing.destroy(error);
    };
    activeRequests.add(abortOnClose);
    const timer = setTimeout(() => {
      const error = unixTransportError(
        socketPath,
        'UNIX_HEADERS_TIMEOUT',
        `Unix response headers did not arrive within ${headersTimeoutMs}ms`,
        'possibly-dispatched',
      );
      rejectOnce(error);
      outgoing.destroy(error);
    }, headersTimeoutMs);
    timer.unref();
    outgoing.once('response', () => clearTimeout(timer));
    outgoing.once('error', (error) => {
      if (error instanceof UnixClientTransportError) return rejectOnce(error);
      const code = errnoOf(error);
      if (code === 'HPE_HEADER_OVERFLOW') {
        return rejectOnce(
          unixTransportError(
            socketPath,
            'UNIX_HEADERS_TOO_LARGE',
            `Unix response headers exceed the ${maxHeaderBytes} byte limit`,
            'response-received',
            error,
          ),
        );
      }
      if (code?.startsWith('HPE_')) {
        return rejectOnce(
          unixTransportError(
            socketPath,
            'UNIX_RESPONSE_ABORTED',
            'Unix response failed before completion',
            'response-received',
            error,
          ),
        );
      }
      // `bytesWritten` includes data buffered before a failed connect on Node, and is
      // cumulative on a pooled socket. Delivery is ambiguous only after connect + writes.
      const dispatched = isDispatched();
      rejectOnce(
        unixTransportError(
          socketPath,
          dispatched ? 'UNIX_DELIVERY_UNCERTAIN' : 'UNIX_CONNECT_FAILED',
          dispatched
            ? 'Unix request transport failed after dispatch may have begun'
            : 'Unix socket connection failed before request dispatch',
          dispatched ? 'possibly-dispatched' : 'not-dispatched',
          error,
        ),
      );
    });
    outgoing.once('close', () => {
      clearTimeout(timer);
      activeRequests.delete(abortOnClose);
    });
    outgoing.end(input.body);
  });
}

/**
 * A Fetch-compatible Unix transport shared by Bun and Node. Socket selection is
 * structural: every request, including redirects, is dispatched through the
 * configured path and can never fall back to TCP.
 */
export function createUnixClientTransport(
  config: UnixClientTransportConfig,
): UnixClientTransport {
  const {
    maxRequestBytes,
    maxResponseBytes,
    headersTimeoutMs,
    maxConnections,
    maxHeaderBytes,
    maxRedirects,
  } = resolveUnixClientLimits(config);
  const agent = new Agent({ keepAlive: true, maxSockets: maxConnections });
  const activeRequests = new Set<() => void>();
  const activeResponses = new Set<IncomingMessage>();
  const bunAborters = new Set<() => void>();
  const closeController = new AbortController();
  let closed = false;
  const closedError = (delivery: UnixClientDeliveryState): UnixClientTransportError =>
    unixTransportError(
      config.socketPath,
      'UNIX_CLIENT_CLOSED',
      'Unix client transport is closed',
      delivery,
    );

  const dispatch = async (request: Request, redirectCount: number): Promise<Response> => {
    if (closed) throw closedError('not-dispatched');
    if (request.signal.aborted) throw abortReason(request.signal);
    const url = new URL(request.url);
    if (url.protocol !== 'http:') {
      throw new TypeError('Unix client transport accepts only http: request URLs');
    }
    assertUnixSocketClientTarget(config.socketPath);
    const body = await readBoundedRequestBody(
      request,
      maxRequestBytes,
      closeController.signal,
    );
    if (closed) throw closedError('not-dispatched');
    if (hasBunUnixRuntime()) {
      if (bunAborters.size >= maxConnections) {
        throw unixTransportError(
          config.socketPath,
          'UNIX_CONNECTION_LIMIT',
          `Unix client connection limit ${maxConnections} reached`,
          'not-dispatched',
        );
      }
      const response = await bunUnixRequest({
        socketPath: config.socketPath,
        request,
        body,
        maxResponseBytes,
        maxHeaderBytes,
        headersTimeoutMs,
        registerAbort(abort) {
          bunAborters.add(abort);
          return () => void bunAborters.delete(abort);
        },
      });
      if (closed) {
        await response.body?.cancel().catch(() => undefined);
        throw closedError('response-received');
      }
      const location = response.headers.get('location');
      let step: 'return' | 'follow';
      try {
        step = redirectStep(request, response.status, location, redirectCount, maxRedirects);
      } catch (error) {
        await response.body?.cancel();
        throw error;
      }
      if (step === 'follow' && location) {
        await response.body?.cancel();
        return dispatch(
          redirectedRequest(request, location, response.status, body),
          redirectCount + 1,
        );
      }
      return response;
    }
    const headers = Object.fromEntries(request.headers.entries());
    if (!Object.keys(headers).some((name) => name.toLowerCase() === 'host')) {
      headers.host = url.host;
    }

    const incoming = await nodeUnixRequest({
      socketPath: config.socketPath,
      url,
      request,
      headers,
      body,
      agent,
      maxHeaderBytes,
      headersTimeoutMs,
      activeRequests,
    });
    if (closed) {
      incoming.destroy();
      throw closedError('response-received');
    }
    activeResponses.add(incoming);
    const releaseResponse = (): void => void activeResponses.delete(incoming);
    const status = incoming.statusCode ?? 0;
    const responseHeadersValue = incomingResponseHeaders(incoming);
    if (exceedsDeclaredResponseBytes(responseHeadersValue, maxResponseBytes)) {
      incoming.destroy();
      releaseResponse();
      throw new UnixClientTransportError(
        'UNIX_RESPONSE_TOO_LARGE',
        `Unix response body exceeds the ${maxResponseBytes} byte limit`,
        'response-received',
      );
    }
    const location = responseHeadersValue.get('location');

    let step: 'return' | 'follow';
    try {
      step = redirectStep(request, status, location, redirectCount, maxRedirects);
    } catch (error) {
      incoming.destroy();
      releaseResponse();
      throw error;
    }
    if (step === 'follow' && location) {
      incoming.destroy();
      releaseResponse();
      return dispatch(redirectedRequest(request, location, status, body), redirectCount + 1);
    }

    const bodyless =
      request.method === 'HEAD' || status === 204 || status === 205 || status === 304;
    if (bodyless) {
      incoming.resume();
      incoming.once('end', releaseResponse);
      return new Response(null, {
        status,
        statusText: incoming.statusMessage,
        headers: responseHeadersValue,
      });
    }
    return new Response(incomingResponseBody(incoming, maxResponseBytes, releaseResponse), {
      status,
      statusText: incoming.statusMessage,
      headers: responseHeadersValue,
    });
  };

  return {
    fetch(input, init) {
      return dispatch(new Request(input, init), 0);
    },
    get closed() {
      return closed;
    },
    async close() {
      if (closed) return;
      closed = true;
      closeController.abort(closedError('not-dispatched'));
      for (const abort of [...activeRequests]) abort();
      for (const response of activeResponses) response.destroy();
      for (const abort of [...bunAborters]) abort();
      activeRequests.clear();
      activeResponses.clear();
      bunAborters.clear();
      agent.destroy();
    },
  };
}

export {
  type UnixClientDeliveryState,
  UnixClientTransportError,
  type UnixClientTransportErrorCode,
} from '../internal/unix-client-error';
