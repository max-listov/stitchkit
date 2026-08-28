import {
  Agent,
  type ClientRequest,
  request as httpRequest,
  type IncomingMessage,
} from 'node:http';
import type { ClientFetch } from '../browser/transport';
import { boundedIncomingBody, readBoundedRequestBody } from './unix-client-body';
import { bunUnixRequest, hasBunUnixRuntime } from './unix-client-bun';
import { UnixClientTransportError } from './unix-client-error';

const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_HEADERS_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CONNECTIONS = 8;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_HEADER_BYTES = 64 * 1024;

export interface UnixClientTransportConfig {
  /** Absolute local socket path selected by deployment configuration. */
  socketPath: string;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  headersTimeoutMs?: number;
  maxHeaderBytes?: number;
  maxConnections?: number;
  /** Redirects stay on this Unix transport. Default 5. */
  maxRedirects?: number;
}

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

/**
 * A Fetch-compatible Unix transport shared by Bun and Node. Socket selection is
 * structural: every request, including redirects, is dispatched through the
 * configured path and can never fall back to TCP.
 */
export function createUnixClientTransport(
  config: UnixClientTransportConfig,
): UnixClientTransport {
  if (!config.socketPath.startsWith('/') || config.socketPath.includes('\0')) {
    throw new TypeError('socketPath must be an absolute Unix socket path');
  }
  const maxRequestBytes = positiveInteger(
    config.maxRequestBytes,
    DEFAULT_MAX_BODY_BYTES,
    'maxRequestBytes',
  );
  const maxResponseBytes = positiveInteger(
    config.maxResponseBytes,
    DEFAULT_MAX_BODY_BYTES,
    'maxResponseBytes',
  );
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
      if (location && isRedirect(response.status)) {
        if (request.redirect === 'error' || redirectCount >= maxRedirects) {
          await response.body?.cancel();
          throw new UnixClientTransportError(
            'UNIX_REDIRECT_REFUSED',
            redirectCount >= maxRedirects
              ? `Unix redirect limit ${maxRedirects} exceeded`
              : 'Unix request redirect mode is error',
            'response-received',
          );
        }
        if (request.redirect === 'follow') {
          await response.body?.cancel();
          return dispatch(
            redirectedRequest(request, location, response.status, body),
            redirectCount + 1,
          );
        }
      }
      return response;
    }
    const headers = Object.fromEntries(request.headers.entries());
    if (!Object.keys(headers).some((name) => name.toLowerCase() === 'host')) {
      headers.host = url.host;
    }

    const incoming = await new Promise<IncomingMessage>((resolve, reject) => {
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
          socketPath: config.socketPath,
          path: `${url.pathname}${url.search}`,
          method: request.method,
          headers,
          agent,
          signal: request.signal,
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
        // `bytesWritten` includes data buffered before a failed connect on
        // Node, and is cumulative on a pooled socket. Delivery is ambiguous
        // only after this socket really connected and this request advanced it.
        const dispatched =
          connected &&
          (outgoing.socket?.bytesWritten ?? requestStartBytes) > requestStartBytes;
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
      outgoing.end(body);
    });
    activeResponses.add(incoming);
    const releaseResponse = (): void => void activeResponses.delete(incoming);
    const status = incoming.statusCode ?? 0;
    const responseHeadersValue = responseHeaders(incoming);
    const declaredResponseBytes = responseHeadersValue.get('content-length');
    if (
      declaredResponseBytes !== null &&
      /^\d+$/.test(declaredResponseBytes) &&
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

    if (location && isRedirect(status)) {
      if (request.redirect === 'error' || redirectCount >= maxRedirects) {
        incoming.destroy();
        releaseResponse();
        throw new UnixClientTransportError(
          'UNIX_REDIRECT_REFUSED',
          redirectCount >= maxRedirects
            ? `Unix redirect limit ${maxRedirects} exceeded`
            : 'Unix request redirect mode is error',
          'response-received',
        );
      }
      if (request.redirect === 'follow') {
        incoming.destroy();
        releaseResponse();
        return dispatch(redirectedRequest(request, location, status, body), redirectCount + 1);
      }
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
    return new Response(boundedIncomingBody(incoming, maxResponseBytes, releaseResponse), {
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
