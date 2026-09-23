import { UnixClientTransportError } from './unix-client-error';
import { BodyDecoder, readResponseHead, requestBytes, WireBuffer } from './unix-client-http1';

interface BunUnixSocket {
  write(data: Uint8Array, byteOffset?: number, byteLength?: number): number;
  pause(): void;
  resume(): void;
  terminate(): void;
}

interface BunUnixRuntime {
  connect(options: {
    unix: string;
    socket: {
      binaryType: 'uint8array';
      open(socket: BunUnixSocket): void;
      drain(socket: BunUnixSocket): void;
      data(socket: BunUnixSocket, data: Uint8Array): void;
      end(socket: BunUnixSocket): void;
      close(socket: BunUnixSocket, error?: Error): void;
      error(socket: BunUnixSocket, error: Error): void;
      connectError(socket: BunUnixSocket, error: Error): void;
    };
  }): Promise<BunUnixSocket>;
}

function isBunUnixRuntime(candidate: unknown): candidate is BunUnixRuntime {
  if (typeof candidate !== 'object' || candidate === null) return false;
  return typeof Reflect.get(candidate, 'connect') === 'function';
}

function runtimeBun(): BunUnixRuntime | undefined {
  const candidate = Reflect.get(globalThis, 'Bun');
  return isBunUnixRuntime(candidate) ? candidate : undefined;
}

export function hasBunUnixRuntime(): boolean {
  return runtimeBun() !== undefined;
}

export interface BunUnixRequestOptions {
  readonly socketPath: string;
  readonly request: Request;
  readonly body?: Uint8Array;
  readonly maxResponseBytes: number | undefined;
  readonly maxHeaderBytes: number;
  readonly headersTimeoutMs: number;
  registerAbort(abort: () => void): () => void;
}

/**
 * What a failure means for the request. After the head arrived it is an
 * aborted response; before, it is uncertain delivery once any request byte was
 * written, and a clean connection failure otherwise.
 */
function classifyTransportFailure(
  error: unknown,
  headersReceived: boolean,
  dispatched: boolean,
): UnixClientTransportError {
  if (error instanceof UnixClientTransportError) return error;
  if (headersReceived) {
    return new UnixClientTransportError(
      'UNIX_RESPONSE_ABORTED',
      'Unix response failed before completion',
      'response-received',
      { cause: error },
    );
  }
  return new UnixClientTransportError(
    dispatched ? 'UNIX_DELIVERY_UNCERTAIN' : 'UNIX_CONNECT_FAILED',
    dispatched
      ? 'Unix request transport failed after dispatch may have begun'
      : 'Unix socket connection failed before request dispatch',
    dispatched ? 'possibly-dispatched' : 'not-dispatched',
    { cause: error },
  );
}

function limitError(
  limit: 'headers' | 'body',
  what: string,
  bytes: number,
): UnixClientTransportError {
  return limit === 'body'
    ? new UnixClientTransportError(
        'UNIX_RESPONSE_TOO_LARGE',
        `Unix response body exceeds the ${bytes} byte limit`,
        'response-received',
      )
    : new UnixClientTransportError(
        'UNIX_HEADERS_TOO_LARGE',
        `Unix response ${what} exceed the ${bytes} byte limit`,
        'response-received',
      );
}

interface SocketEvents {
  open(active: BunUnixSocket): void;
  flush(active: BunUnixSocket): void;
  /** Called with the socket already paused: the next read is the stream's to ask for. */
  data(data: Uint8Array): void;
  /** The peer ended or closed the connection, with the error when it was one. */
  ended(error: Error | undefined, how: 'ended' | 'closed'): void;
  failed(error: Error): void;
}

function socketHandlers(events: SocketEvents) {
  return {
    binaryType: 'uint8array' as const,
    open: events.open,
    drain: events.flush,
    data(active: BunUnixSocket, data: Uint8Array) {
      active.pause();
      events.data(data);
    },
    end: () => events.ended(undefined, 'ended'),
    close: (_active: BunUnixSocket, error?: Error) => events.ended(error, 'closed'),
    error: (_active: BunUnixSocket, error: Error) => events.failed(error),
    connectError: (_active: BunUnixSocket, error: Error) => events.failed(error),
  };
}

/**
 * Write as much of the request as the socket takes now; the new offset, or
 * `closed`. The complete HTTP message is delimited by Content-Length (or by the
 * empty body after CRLFCRLF). `Socket.end()` closes Bun's whole socket, not
 * merely the write half, so it is left open for the response; `Connection:
 * close` makes the peer own normal termination.
 */
function writeAvailable(
  active: BunUnixSocket,
  bytes: Uint8Array,
  offset: number,
): number | 'closed' {
  let written = offset;
  while (written < bytes.byteLength) {
    const count = active.write(bytes, written, bytes.byteLength - written);
    if (count < 0) return 'closed';
    if (count === 0) break;
    written += count;
  }
  return written;
}

/** Bun's raw socket lane: pausing the socket makes unread body memory physically bounded. */
export function bunUnixRequest(options: BunUnixRequestOptions): Promise<Response> {
  const outgoing = requestBytes(options.request, options.body);
  const bun = runtimeBun();
  if (!bun) throw new Error('Bun Unix runtime is unavailable');
  let socket: BunUnixSocket | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const wire = new WireBuffer();
  let decoder: BodyDecoder | undefined;
  let responseResolved = false;
  let headersReceived = false;
  let settled = false;
  let bodyComplete = false;
  let peerEnded = false;
  let received = 0;
  let writeOffset = 0;
  let resolveResponse: (response: Response) => void = () => undefined;
  let rejectResponse: (error: unknown) => void = () => undefined;
  const response = new Promise<Response>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });

  const transportFailure = (error: unknown): UnixClientTransportError =>
    classifyTransportFailure(error, headersReceived, writeOffset > 0);

  const clearRegistration = options.registerAbort(() => {
    fail(
      new UnixClientTransportError('UNIX_CLIENT_CLOSED', 'Unix client transport is closed'),
    );
  });
  const timer = setTimeout(() => {
    fail(
      new UnixClientTransportError(
        'UNIX_HEADERS_TIMEOUT',
        `Unix response headers did not arrive within ${options.headersTimeoutMs}ms`,
      ),
    );
  }, options.headersTimeoutMs);
  timer.unref();

  const removeRequestAbort = (): void => {
    options.request.signal.removeEventListener('abort', abortRequest);
  };

  const finish = (terminate = true): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearRegistration();
    removeRequestAbort();
    if (terminate) socket?.terminate();
  };

  function fail(error: unknown): void {
    if (settled) return;
    if (responseResolved) controller?.error(error);
    else rejectResponse(error);
    finish();
  }

  function abortRequest(): void {
    fail(options.request.signal.reason ?? new DOMException('Request aborted', 'AbortError'));
  }

  const enqueue = (value: Uint8Array): void => {
    if (options.maxResponseBytes !== undefined) received += value.byteLength;
    if (options.maxResponseBytes !== undefined && received > options.maxResponseBytes) {
      fail(limitError('body', 'body', options.maxResponseBytes));
      return;
    }
    controller?.enqueue(value);
  };

  const completeBody = (): void => {
    if (bodyComplete || settled) return;
    bodyComplete = true;
    controller?.close();
    finish();
  };

  const resumeForData = (): void => {
    if (settled || bodyComplete || peerEnded) return;
    socket?.resume();
  };

  const headersTooLarge = (what: string) =>
    limitError('headers', what, options.maxHeaderBytes);

  const pump = (): void => {
    while (controller && decoder && !settled && !bodyComplete) {
      if ((controller.desiredSize ?? 1) <= 0) return;
      const step = decoder.next(wire, peerEnded);
      if (step.kind === 'data') {
        enqueue(step.value);
        if (!settled && decoder.plainComplete) completeBody();
      } else if (step.kind === 'more') resumeForData();
      else if (step.kind === 'complete') completeBody();
      else if (step.kind === 'malformed') fail(transportFailure(step.error));
      else fail(headersTooLarge('trailers'));
      return;
    }
  };

  const parseHeaders = (): void => {
    const head = readResponseHead(wire, options.maxHeaderBytes);
    if (head.kind !== 'head') {
      if (head.kind === 'malformed') headersReceived = true;
      if (head.kind === 'more') socket?.resume();
      else if (head.kind === 'too-large') fail(headersTooLarge('headers'));
      else fail(transportFailure(head.error));
      return;
    }
    headersReceived = true;
    const { status, statusText, headers, contentLength } = head;
    if (
      options.maxResponseBytes !== undefined &&
      contentLength !== undefined &&
      contentLength > options.maxResponseBytes
    ) {
      fail(limitError('body', 'body', options.maxResponseBytes));
      return;
    }
    decoder = new BodyDecoder(head.chunked, contentLength, options.maxHeaderBytes);
    const bodyless =
      options.request.method === 'HEAD' || status === 204 || status === 205 || status === 304;
    clearTimeout(timer);
    responseResolved = true;
    if (bodyless || contentLength === 0) {
      resolveResponse(new Response(null, { status, statusText, headers }));
      finish();
      return;
    }
    const body = new ReadableStream<Uint8Array>(
      {
        start(value) {
          controller = value;
          pump();
        },
        pull() {
          pump();
        },
        cancel() {
          finish();
        },
      },
      { highWaterMark: 1 },
    );
    resolveResponse(new Response(body, { status, statusText, headers }));
  };

  const flushRequest = (active: BunUnixSocket): void => {
    const next = writeAvailable(active, outgoing, writeOffset);
    if (next === 'closed') {
      fail(transportFailure(new Error('Unix request socket closed while writing')));
    } else writeOffset = next;
  };

  if (options.request.signal.aborted) {
    fail(options.request.signal.reason ?? new DOMException('Request aborted', 'AbortError'));
    return response;
  }
  options.request.signal.addEventListener('abort', abortRequest, { once: true });

  void bun
    .connect({
      unix: options.socketPath,
      socket: socketHandlers({
        open(active) {
          socket = active;
          if (settled) active.terminate();
          else flushRequest(active);
        },
        flush: flushRequest,
        data(data) {
          wire.append(data);
          if (!responseResolved) parseHeaders();
          else pump();
        },
        ended(error, how) {
          peerEnded = true;
          if (settled) return;
          if (error) fail(transportFailure(error));
          else if (!responseResolved) {
            fail(
              transportFailure(new Error(`Unix connection ${how} before response headers`)),
            );
          } else pump();
        },
        failed: (error) => fail(transportFailure(error)),
      }),
    })
    .catch((error: unknown) => fail(transportFailure(error)));

  return response;
}
