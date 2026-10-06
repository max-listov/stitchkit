/**
 * A Bot API transport that knows whether its request left.
 *
 * `fetch` folds establishing the connection and waiting for the answer into one failure, and
 * from that failure nobody can say whether Telegram saw the message. A sender that must never
 * duplicate a message then treats every network failure as "maybe delivered" and never repeats
 * it, so a route that only sometimes fails to connect loses messages outright.
 *
 * This transport connects first and writes the request only on an established connection.
 * Until the first byte is written, every failure is `TelegramNotDispatchedError`: the request
 * certainly did not leave and repeating it is safe. After that, a failure is an ordinary error,
 * because the request may have arrived. Addresses come in the system resolver's order with no
 * family forced; the next address starts after a short delay (Happy Eyeballs), and a round with
 * no connection is repeated with new sockets inside a bounded budget.
 */

import { assertPositiveSafeInteger } from '../internal/positive-integer';
import { untilAborted } from '../internal/until-aborted';
import { TelegramNotDispatchedError } from './not-dispatched';
import {
  establish,
  openSocket,
  resolveAll,
  type TelegramBotTransportOpen,
  type TelegramBotTransportResolve,
  type TelegramBotTransportSocket,
} from './transport-connect';

export type {
  TelegramBotTransportOpen,
  TelegramBotTransportResolve,
  TelegramBotTransportSocket,
} from './transport-connect';

/** What the Bot API senders call: a URL and a request, answered by a `Response`. */
export type TelegramFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface TelegramBotTransportOptions {
  /** Real milliseconds one connection round waits. Default 2000: one kernel SYN retry fits. */
  readonly connectAttemptMs?: number;
  /** Real milliseconds after which no new connection round starts. Default 5000. */
  readonly connectBudgetMs?: number;
  /** Real milliseconds from the written request to the end of the answer. Default 30 000. */
  readonly responseTimeoutMs?: number;
  /** Largest answer read, in bytes. Default 1 MiB. */
  readonly maxResponseBytes?: number;
  /** Address lookup. Default: the system resolver, every address in its order. */
  readonly resolve?: TelegramBotTransportResolve;
  /** Socket factory. Default: TLS (ALPN `http/1.1`) for `https:`, plain TCP for `http:`. */
  readonly open?: TelegramBotTransportOpen;
}

function chunkedBody(body: Buffer): Buffer {
  const parts: Buffer[] = [];
  let at = 0;
  for (;;) {
    const lineEnd = body.indexOf('\r\n', at);
    if (lineEnd < 0) throw new Error('Telegram chunked answer was truncated');
    const size = Number.parseInt(body.subarray(at, lineEnd).toString('latin1'), 16);
    if (!Number.isSafeInteger(size) || size < 0)
      throw new Error('Telegram chunked answer had an invalid chunk size');
    if (size === 0) return Buffer.concat(parts);
    const start = lineEnd + 2;
    if (start + size > body.length) throw new Error('Telegram chunked answer was truncated');
    parts.push(body.subarray(start, start + size));
    at = start + size + 2;
  }
}

interface AnswerHead {
  readonly bodyStart: number;
  readonly status: number;
  readonly headers: Headers;
}

/** The status line and headers, once the blank line after them has arrived. */
function answerHead(raw: Buffer): AnswerHead | undefined {
  const headEnd = raw.indexOf('\r\n\r\n');
  if (headEnd < 0) return undefined;
  const [statusLine = '', ...lines] = raw
    .subarray(0, headEnd)
    .toString('latin1')
    .split('\r\n');
  const status = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine)?.[1];
  if (status === undefined) throw new Error('Telegram answer had an invalid status line');
  if (Number(status) < 200)
    throw new Error(
      `Telegram answer was an interim response (HTTP ${status}), not a final one`,
    );
  const headers = new Headers();
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return { bodyStart: headEnd + 4, status: Number(status), headers };
}

const bodiless = (status: number) => status === 204 || status === 304;
const isChunked = (headers: Headers) =>
  /\bchunked\b/i.test(headers.get('transfer-encoding') ?? '');

/**
 * The declared body length. A repeated header with one value (`11, 11`) is one declaration; two
 * different values, or one that is not a number, make the framing untrustworthy.
 */
function declaredLength(headers: Headers): number | undefined {
  const raw = headers.get('content-length');
  if (raw === null) return undefined;
  const values = new Set(raw.split(',').map((value) => value.trim()));
  const [only = ''] = values;
  if (values.size !== 1 || !/^\d{1,15}$/.test(only))
    throw new Error('Telegram answer had an invalid Content-Length');
  return Number(only);
}

/**
 * Whether the answer is complete before the connection closes: its `Content-Length` arrived, its
 * last chunk arrived, or its status carries no body. Without either framing it ends with the
 * connection.
 */
function answerComplete(raw: Buffer): boolean {
  const head = answerHead(raw);
  if (!head) return false;
  if (bodiless(head.status)) return true;
  const body = raw.subarray(head.bodyStart);
  if (isChunked(head.headers)) {
    try {
      chunkedBody(body);
      return true;
    } catch {
      return false;
    }
  }
  const length = declaredLength(head.headers);
  return length !== undefined && body.length >= length;
}

/** An HTTP/1.1 answer, framed by its length, its chunks or the connection's end, as a `Response`. */
function parseAnswer(raw: Buffer): Response {
  const head = answerHead(raw);
  if (!head) throw new Error('Telegram answer ended inside its head');
  const { status, headers } = head;
  let body = raw.subarray(head.bodyStart);
  if (isChunked(headers)) {
    body = chunkedBody(body);
    // The chunks frame the body, as `Transfer-Encoding` takes precedence over a length.
    headers.delete('content-length');
  } else {
    const expected = declaredLength(headers);
    if (expected !== undefined) {
      if (body.length < expected) throw new Error('Telegram answer body was truncated');
      body = body.subarray(0, expected);
    }
  }
  headers.delete('transfer-encoding');
  return new Response(bodiless(status) ? null : new Uint8Array(body), { status, headers });
}

/** Writes the request on the connected socket and reads the answer to the connection's end. */
function exchange(
  socket: TelegramBotTransportSocket,
  request: Buffer,
  limits: { maxResponseBytes: number; responseTimeoutMs: number },
  signal: AbortSignal | undefined,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let done = false;
    const finish = (error: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      if (error !== undefined) {
        reject(error);
        return;
      }
      try {
        resolve(parseAnswer(Buffer.concat(chunks)));
      } catch (parseError) {
        reject(parseError);
      }
    };
    const abort = () => finish(signal?.reason);
    const timer = setTimeout(
      () =>
        finish(new Error(`Telegram answer took longer than ${limits.responseTimeoutMs} ms`)),
      limits.responseTimeoutMs,
    );
    socket.on('data', (chunk) => {
      bytes += chunk.byteLength;
      if (bytes > limits.maxResponseBytes) {
        finish(new Error(`Telegram answer exceeded ${limits.maxResponseBytes} bytes`));
        return;
      }
      chunks.push(chunk);
      // A server that keeps the connection open after a framed answer has still answered.
      try {
        if (answerComplete(Buffer.concat(chunks))) finish(undefined);
      } catch (error) {
        finish(error);
      }
    });
    socket.once('end', () => finish(undefined));
    socket.once('close', () => finish(undefined));
    socket.once('error', (error) => finish(error));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else socket.write(request);
  });
}

async function requestBytes(
  url: URL,
  init: RequestInit,
  signal: AbortSignal | undefined,
): Promise<{ head: string; body: Uint8Array }> {
  let request: Request;
  let headers: [string, string][];
  let body: Uint8Array;
  try {
    // A Request serialises every body `fetch` accepts, multipart boundary included. Its headers
    // are read before its body: Bun derives a body's content type lazily and loses it once the
    // body has been consumed.
    request = new Request(url, { ...init, signal: null });
    // The transport frames the request itself: these are its own, never the caller's.
    headers = [...request.headers].filter(
      ([name]) =>
        !['host', 'content-length', 'connection', 'transfer-encoding'].includes(name),
    );
    // A body the caller streams may never end: only the caller's signal bounds this read.
    const read = request.arrayBuffer();
    body = new Uint8Array(await (signal ? untilAborted(read, signal) : read));
  } catch (cause) {
    signal?.throwIfAborted();
    throw new TelegramNotDispatchedError(
      'request',
      'Telegram request body could not be read',
      {
        cause,
      },
    );
  }
  const head = [
    `${request.method} ${url.pathname}${url.search} HTTP/1.1`,
    `Host: ${url.host}`,
    ...headers.map(([name, value]) => `${name}: ${value}`),
    `Content-Length: ${body.byteLength}`,
    'Connection: close',
    '',
    '',
  ].join('\r\n');
  return { head, body };
}

/**
 * A `fetch` for the Bot API senders (`callTelegramBotApi`, `telegramBroadcastSender`,
 * `telegramOperatorSender`) that separates "not sent" from "unknown". Pass it as their `fetch`:
 * a failure before the request is written throws `TelegramNotDispatchedError`, which
 * `classifyTelegramSendFailure` reads as `not-dispatched` (retryable); any later failure stays
 * an outcome nobody can know. Speaks HTTP/1.1 over `https:` (and `http:` for a local Bot API
 * server); it does not use a proxy.
 */
export function createTelegramBotTransport(
  options: TelegramBotTransportOptions = {},
): TelegramFetch {
  const connectAttemptMs = options.connectAttemptMs ?? 2_000;
  const connectBudgetMs = options.connectBudgetMs ?? 5_000;
  const responseTimeoutMs = options.responseTimeoutMs ?? 30_000;
  const maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
  assertPositiveSafeInteger('connectAttemptMs', connectAttemptMs);
  assertPositiveSafeInteger('connectBudgetMs', connectBudgetMs);
  assertPositiveSafeInteger('responseTimeoutMs', responseTimeoutMs);
  assertPositiveSafeInteger('maxResponseBytes', maxResponseBytes);
  const policy = {
    resolve: options.resolve ?? resolveAll,
    open: options.open ?? openSocket,
    attemptMs: connectAttemptMs,
    budgetMs: connectBudgetMs,
  };
  return async (url, init) => {
    const signal = init.signal ?? undefined;
    signal?.throwIfAborted();
    const target = new URL(url);
    const tls = target.protocol === 'https:';
    if (!tls && target.protocol !== 'http:')
      throw new TelegramNotDispatchedError(
        'request',
        `Telegram transport speaks http and https, not ${target.protocol}`,
      );
    const { head, body } = await requestBytes(target, init, signal);
    signal?.throwIfAborted();
    const socket = await establish(
      target.hostname.replace(/^\[|\]$/g, ''),
      Number(target.port || (tls ? 443 : 80)),
      tls,
      policy,
      signal,
    );
    return exchange(
      socket,
      Buffer.concat([Buffer.from(head, 'latin1'), body]),
      { maxResponseBytes, responseTimeoutMs },
      signal,
    );
  };
}
