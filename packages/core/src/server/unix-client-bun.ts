import { UnixClientTransportError } from './unix-client-error';

const MAX_BODY_CHUNK_BYTES = 64 * 1024;

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
  readonly maxResponseBytes: number;
  readonly maxHeaderBytes: number;
  readonly headersTimeoutMs: number;
  registerAbort(abort: () => void): () => void;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right.slice();
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
}

function indexOfSequence(bytes: Uint8Array, sequence: readonly number[]): number {
  outer: for (let index = 0; index <= bytes.byteLength - sequence.length; index += 1) {
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (bytes[index + offset] !== sequence[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

function requestBytes(request: Request, body: Uint8Array | undefined): Uint8Array {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.set('host', url.host);
  headers.set('connection', 'close');
  headers.set('accept-encoding', 'identity');
  headers.delete('transfer-encoding');
  headers.delete('content-length');
  if (body !== undefined) headers.set('content-length', String(body.byteLength));
  const lines = [`${request.method} ${url.pathname}${url.search} HTTP/1.1`];
  for (const [name, value] of headers) lines.push(`${name}: ${value}`);
  const head = new TextEncoder().encode(`${lines.join('\r\n')}\r\n\r\n`);
  return body === undefined ? head : concatBytes(head, body);
}

function parseContentLength(headers: Headers): number | undefined {
  const raw = headers.get('content-length');
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw)) throw new Error('Unix response has an invalid Content-Length');
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error('Unix response Content-Length is not a safe integer');
  }
  return value;
}

/** Bun's raw socket lane: pausing the socket makes unread body memory physically bounded. */
export function bunUnixRequest(options: BunUnixRequestOptions): Promise<Response> {
  const outgoing = requestBytes(options.request, options.body);
  const bun = runtimeBun();
  if (!bun) throw new Error('Bun Unix runtime is unavailable');
  let socket: BunUnixSocket | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let wire: Uint8Array = new Uint8Array();
  let responseResolved = false;
  let headersReceived = false;
  let settled = false;
  let bodyComplete = false;
  let peerEnded = false;
  let chunked = false;
  let chunkRemaining: number | undefined;
  let expectChunkCrlf = false;
  let trailers = false;
  let remainingLength: number | undefined;
  let received = 0;
  let writeOffset = 0;
  let resolveResponse: (response: Response) => void = () => undefined;
  let rejectResponse: (error: unknown) => void = () => undefined;
  const response = new Promise<Response>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });

  const transportFailure = (error: unknown): UnixClientTransportError => {
    if (error instanceof UnixClientTransportError) return error;
    if (headersReceived) {
      return new UnixClientTransportError(
        'UNIX_RESPONSE_ABORTED',
        'Unix response failed before completion',
        'response-received',
        { cause: error },
      );
    }
    const dispatched = writeOffset > 0;
    return new UnixClientTransportError(
      dispatched ? 'UNIX_DELIVERY_UNCERTAIN' : 'UNIX_CONNECT_FAILED',
      dispatched
        ? 'Unix request transport failed after dispatch may have begun'
        : 'Unix socket connection failed before request dispatch',
      dispatched ? 'possibly-dispatched' : 'not-dispatched',
      { cause: error },
    );
  };

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

  const takeWire = (bytes: number): Uint8Array => {
    const value = wire.slice(0, bytes);
    wire = wire.slice(bytes);
    return value;
  };

  const enqueue = (value: Uint8Array): void => {
    received += value.byteLength;
    if (received > options.maxResponseBytes) {
      fail(
        new UnixClientTransportError(
          'UNIX_RESPONSE_TOO_LARGE',
          `Unix response body exceeds the ${options.maxResponseBytes} byte limit`,
          'response-received',
        ),
      );
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

  const pumpChunked = (): void => {
    if (!controller || settled || bodyComplete) return;
    for (;;) {
      if ((controller.desiredSize ?? 1) <= 0) return;
      if (trailers) {
        if (wire.byteLength >= 2 && wire[0] === 13 && wire[1] === 10) {
          takeWire(2);
          completeBody();
          return;
        }
        const trailerEnd = indexOfSequence(wire, [13, 10, 13, 10]);
        if (trailerEnd < 0) {
          if (wire.byteLength > options.maxHeaderBytes) {
            fail(
              new UnixClientTransportError(
                'UNIX_HEADERS_TOO_LARGE',
                `Unix response trailers exceed the ${options.maxHeaderBytes} byte limit`,
                'response-received',
              ),
            );
          } else if (peerEnded) {
            fail(transportFailure(new Error('Unix chunked response ended inside trailers')));
          } else {
            resumeForData();
          }
          return;
        }
        takeWire(trailerEnd + 4);
        completeBody();
        return;
      }
      if (expectChunkCrlf) {
        if (wire.byteLength < 2) {
          if (peerEnded) {
            fail(
              transportFailure(
                new Error('Unix chunked response ended before chunk delimiter'),
              ),
            );
          } else resumeForData();
          return;
        }
        if (wire[0] !== 13 || wire[1] !== 10) {
          fail(
            transportFailure(
              new Error('Unix chunked response has an invalid chunk delimiter'),
            ),
          );
          return;
        }
        takeWire(2);
        expectChunkCrlf = false;
      }
      if (chunkRemaining === undefined) {
        const lineEnd = indexOfSequence(wire, [13, 10]);
        if (lineEnd < 0) {
          if (wire.byteLength > 1_024) {
            fail(transportFailure(new Error('Unix chunk header is too large')));
          } else if (peerEnded) {
            fail(
              transportFailure(new Error('Unix chunked response ended inside chunk header')),
            );
          } else resumeForData();
          return;
        }
        const line = new TextDecoder('ascii', { fatal: true }).decode(takeWire(lineEnd));
        takeWire(2);
        const sizeText = line.split(';', 1)[0]?.trim() ?? '';
        if (!/^[0-9a-f]+$/i.test(sizeText)) {
          fail(transportFailure(new Error('Unix chunked response has an invalid chunk size')));
          return;
        }
        chunkRemaining = Number.parseInt(sizeText, 16);
        if (!Number.isSafeInteger(chunkRemaining)) {
          fail(transportFailure(new Error('Unix chunk size is not a safe integer')));
          return;
        }
        if (chunkRemaining === 0) {
          chunkRemaining = undefined;
          trailers = true;
          continue;
        }
      }
      if (wire.byteLength === 0) {
        if (peerEnded) {
          fail(transportFailure(new Error('Unix chunked response ended inside a chunk')));
        } else resumeForData();
        return;
      }
      const bytes = Math.min(chunkRemaining, wire.byteLength, MAX_BODY_CHUNK_BYTES);
      enqueue(takeWire(bytes));
      if (settled) return;
      chunkRemaining -= bytes;
      if (chunkRemaining === 0) {
        chunkRemaining = undefined;
        expectChunkCrlf = true;
      }
      return;
    }
  };

  const pumpPlain = (): void => {
    if (!controller || settled || bodyComplete) return;
    if ((controller.desiredSize ?? 1) <= 0) return;
    if (wire.byteLength > 0) {
      const permitted = remainingLength ?? wire.byteLength;
      const bytes = Math.min(permitted, wire.byteLength, MAX_BODY_CHUNK_BYTES);
      enqueue(takeWire(bytes));
      if (settled) return;
      if (remainingLength !== undefined) {
        remainingLength -= bytes;
        if (remainingLength === 0) {
          completeBody();
          return;
        }
      }
      return;
    }
    if (peerEnded) {
      if (remainingLength !== undefined && remainingLength > 0) {
        fail(
          transportFailure(
            new Error('Unix response ended before Content-Length bytes arrived'),
          ),
        );
      } else {
        completeBody();
      }
      return;
    }
    resumeForData();
  };

  const pump = (): void => {
    if (chunked) pumpChunked();
    else pumpPlain();
  };

  const parseHeaders = (): void => {
    const headerEnd = indexOfSequence(wire, [13, 10, 13, 10]);
    if (headerEnd < 0) {
      if (wire.byteLength > options.maxHeaderBytes) {
        fail(
          new UnixClientTransportError(
            'UNIX_HEADERS_TOO_LARGE',
            `Unix response headers exceed the ${options.maxHeaderBytes} byte limit`,
            'response-received',
          ),
        );
      } else {
        socket?.resume();
      }
      return;
    }
    if (headerEnd > options.maxHeaderBytes) {
      fail(
        new UnixClientTransportError(
          'UNIX_HEADERS_TOO_LARGE',
          `Unix response headers exceed the ${options.maxHeaderBytes} byte limit`,
          'response-received',
        ),
      );
      return;
    }
    headersReceived = true;
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(takeWire(headerEnd));
    } catch (error) {
      fail(transportFailure(error));
      return;
    }
    takeWire(4);
    const lines = text.split('\r\n');
    const statusLine = lines.shift() ?? '';
    const matched = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(statusLine);
    if (!matched) {
      fail(transportFailure(new Error('Unix response has an invalid HTTP status line')));
      return;
    }
    const status = Number(matched[1]);
    const statusText = matched[2] ?? '';
    const headers = new Headers();
    try {
      for (const line of lines) {
        const separator = line.indexOf(':');
        if (separator <= 0) throw new Error('Unix response has an invalid header line');
        headers.append(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
      }
      remainingLength = parseContentLength(headers);
    } catch (error) {
      fail(transportFailure(error));
      return;
    }
    if (remainingLength !== undefined && remainingLength > options.maxResponseBytes) {
      fail(
        new UnixClientTransportError(
          'UNIX_RESPONSE_TOO_LARGE',
          `Unix response body exceeds the ${options.maxResponseBytes} byte limit`,
          'response-received',
        ),
      );
      return;
    }
    chunked = headers.get('transfer-encoding')?.toLowerCase().includes('chunked') ?? false;
    const bodyless =
      options.request.method === 'HEAD' || status === 204 || status === 205 || status === 304;
    clearTimeout(timer);
    responseResolved = true;
    if (bodyless || remainingLength === 0) {
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
    while (writeOffset < outgoing.byteLength) {
      const written = active.write(outgoing, writeOffset, outgoing.byteLength - writeOffset);
      if (written < 0) {
        fail(transportFailure(new Error('Unix request socket closed while writing')));
        return;
      }
      if (written === 0) return;
      writeOffset += written;
    }
    // The complete HTTP message is delimited by Content-Length (or by the
    // empty body after CRLFCRLF). `Socket.end()` closes Bun's whole socket, not
    // merely the write half, so leave it open for the response; Connection:
    // close makes the peer own normal termination.
  };

  if (options.request.signal.aborted) {
    fail(options.request.signal.reason ?? new DOMException('Request aborted', 'AbortError'));
    return response;
  }
  options.request.signal.addEventListener('abort', abortRequest, { once: true });

  void bun
    .connect({
      unix: options.socketPath,
      socket: {
        binaryType: 'uint8array',
        open(active) {
          socket = active;
          if (settled) {
            active.terminate();
            return;
          }
          flushRequest(active);
        },
        drain(active) {
          flushRequest(active);
        },
        data(active, data) {
          active.pause();
          wire = concatBytes(wire, data);
          if (!responseResolved) parseHeaders();
          else pump();
        },
        end() {
          peerEnded = true;
          if (!responseResolved) {
            fail(transportFailure(new Error('Unix connection ended before response headers')));
          } else pump();
        },
        close(_active, error) {
          peerEnded = true;
          if (settled) return;
          if (error) fail(transportFailure(error));
          else if (!responseResolved) {
            fail(
              transportFailure(new Error('Unix connection closed before response headers')),
            );
          } else pump();
        },
        error(_active, error) {
          fail(transportFailure(error));
        },
        connectError(_active, error) {
          fail(transportFailure(error));
        },
      },
    })
    .catch((error: unknown) => fail(transportFailure(error)));

  return response;
}
