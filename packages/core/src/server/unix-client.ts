import {
  Agent,
  type ClientRequest,
  request as httpRequest,
  type IncomingMessage,
} from 'node:http';
import type { ClientFetch } from '../browser/transport';
import { incomingResponseBody, readBoundedRequestBody } from './unix-client-body';
import { bunUnixRequest, hasBunUnixRuntime } from './unix-client-bun';
import { UnixClientTransportError } from './unix-client-error';

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
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
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

function requestBody(body: Uint8Array | undefined): ArrayBuffer | undefined {
  if (body === undefined) return undefined;
  const copy = new ArrayBuffer(body.byteLength);
  new Uint8Array(copy).set(body);
  return copy;
}

function responseHeaders(response: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index];
    const value = response.rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) headers.append(name, value);
  }
  return headers;
}

function isNodeHeaderOverflow(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    Reflect.get(error, 'code') === 'HPE_HEADER_OVERFLOW'
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
    ...(!changesToGet && body !== undefined && { body: requestBody(body) }),
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
  const maxRequestBytes = positiveInteger(
    config.maxRequestBytes,
    DEFAULT_MAX_BODY_BYTES,
    'maxRequestBytes',
  );
  if (config.responseBodyMode === 'streaming' && config.maxResponseBytes !== undefined) {
    throw new TypeError('maxResponseBytes cannot be combined with responseBodyMode streaming');
  }
  const maxResponseBytes =
    config.responseBodyMode === 'streaming'
      ? undefined
      : positiveInteger(config.maxResponseBytes, DEFAULT_MAX_BODY_BYTES, 'maxResponseBytes');
  const headersTimeoutMs = positiveInteger(
    config.headersTimeoutMs,
    DEFAULT_HEADERS_TIMEOUT_MS,
    'headersTimeoutMs',
  );
  const maxConnections = positiveInteger(
    config.maxConnections,
    DEFAULT_MAX_CONNECTIONS,
    'maxConnections',
  );
  const maxHeaderBytes = positiveInteger(
    config.maxHeaderBytes,
    DEFAULT_MAX_HEADER_BYTES,
    'maxHeaderBytes',
  );
  const maxRedirects = nonNegativeInteger(
    config.maxRedirects,
    DEFAULT_MAX_REDIRECTS,
    'maxRedirects',
  );
  return {
    maxRequestBytes,
    maxResponseBytes,
    headersTimeoutMs,
    maxConnections,
    maxHeaderBytes,
    maxRedirects,
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
  activeRequests: Set<ClientRequest>;
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
    activeRequests.add(outgoing);
    const timer = setTimeout(() => {
      const error = new UnixClientTransportError(
        'UNIX_HEADERS_TIMEOUT',
        `Unix response headers did not arrive within ${headersTimeoutMs}ms`,
      );
      rejectOnce(error);
      outgoing.destroy(error);
    }, headersTimeoutMs);
    timer.unref();
    outgoing.once('response', () => clearTimeout(timer));
    outgoing.once('error', (error) => {
      if (isNodeHeaderOverflow(error)) {
        rejectOnce(
          new UnixClientTransportError(
            'UNIX_HEADERS_TOO_LARGE',
            `Unix response headers exceed the ${maxHeaderBytes} byte limit`,
            'response-received',
            { cause: error },
          ),
        );
        return;
      }
      // `bytesWritten` includes data buffered before a failed connect on
      // Node, and is cumulative on a pooled socket. Delivery is ambiguous
      // only after this socket really connected and this request advanced it.
      const dispatched =
        connected && (outgoing.socket?.bytesWritten ?? requestStartBytes) > requestStartBytes;
      rejectOnce(
        new UnixClientTransportError(
          dispatched ? 'UNIX_DELIVERY_UNCERTAIN' : 'UNIX_CONNECT_FAILED',
          dispatched
            ? 'Unix request transport failed after dispatch may have begun'
            : 'Unix socket connection failed before request dispatch',
          dispatched ? 'possibly-dispatched' : 'not-dispatched',
          { cause: error },
        ),
      );
    });
    outgoing.once('close', () => {
      clearTimeout(timer);
      activeRequests.delete(outgoing);
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
  const activeRequests = new Set<ClientRequest>();
  const activeResponses = new Set<IncomingMessage>();
  const bunAborters = new Set<() => void>();
  let closed = false;

  const dispatch = async (request: Request, redirectCount: number): Promise<Response> => {
    if (closed) {
      throw new UnixClientTransportError(
        'UNIX_CLIENT_CLOSED',
        'Unix client transport is closed',
        'not-dispatched',
      );
    }
    if (request.signal.aborted) throw request.signal.reason;
    const url = new URL(request.url);
    if (url.protocol !== 'http:') {
      throw new TypeError('Unix client transport accepts only http: request URLs');
    }
    const body = await readBoundedRequestBody(request, maxRequestBytes);
    if (hasBunUnixRuntime()) {
      if (bunAborters.size >= maxConnections) {
        throw new UnixClientTransportError(
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
    activeResponses.add(incoming);
    const releaseResponse = (): void => void activeResponses.delete(incoming);
    const status = incoming.statusCode ?? 0;
    const responseHeadersValue = responseHeaders(incoming);
    const declaredResponseBytes = responseHeadersValue.get('content-length');
    if (
      declaredResponseBytes !== null &&
      /^\d+$/.test(declaredResponseBytes) &&
      maxResponseBytes !== undefined &&
      Number(declaredResponseBytes) > maxResponseBytes
    ) {
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
      for (const request of activeRequests) request.destroy();
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
} from './unix-client-error';
