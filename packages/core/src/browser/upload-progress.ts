/**
 * Upload progress for one client call: a delivery wrapper that reports how
 * much of the request body has gone out.
 *
 * Fetch has no upload event, so the count comes from one of three places:
 *
 * - **stream** (Bun, Node, an injected fetch, a unix socket): the body is
 *   encoded once and leaves as a `ReadableStream` the transport pulls in
 *   64 KiB pieces, with an exact `content-length`. A piece counts when the
 *   transport takes it.
 * - **xhr** (a browser on its own fetch): the encoded body goes through
 *   `XMLHttpRequest`, whose upload events are the only upload signal every
 *   browser has — a streaming request body needs HTTP/2 in Chromium and does
 *   not exist in Safari.
 * - **native-xhr** (React Native, Expo): the body goes to the platform's
 *   `XMLHttpRequest` as the client built it — a `FormData` whose
 *   `{ uri, name, type }` file the platform streams from disk, or a JSON
 *   string — and its upload events are the count. React Native has neither a
 *   streaming request body nor a way to read such a `FormData` back into
 *   bytes, and must not load the file into memory to count it.
 *
 * Every call of the wrapper is one attempt, so a transport retry starts the
 * count again under the next attempt number.
 */

import type { UploadProgress } from '../contract/client-types';
import type { ClientFetch } from './transport';

type UploadProgressListener = (progress: UploadProgress) => void;

/** Where upload bytes are counted. */
export type UploadProgressRoute = 'stream' | 'xhr' | 'native-xhr';

const PIECE_BYTES = 64 * 1024;

/** React Native marks its runtime this way; a browser, Bun and Node do not. */
function isReactNative(): boolean {
  return Reflect.get(globalThis.navigator ?? {}, 'product') === 'ReactNative';
}

/**
 * A browser's own fetch counts through XHR, React Native's through its native
 * XHR; anything else streams. React Native cannot stream a request body, so an
 * injected fetch there is refused rather than reporting a buffered body at once.
 */
export function uploadProgressRoute(injectedTransport: boolean): UploadProgressRoute {
  if (isReactNative()) {
    if (injectedTransport) {
      throw new TypeError(
        'onUploadProgress in React Native counts through its XMLHttpRequest and cannot count an injected fetch — drop the custom fetch for this client',
      );
    }
    return 'native-xhr';
  }
  return !injectedTransport && typeof globalThis.XMLHttpRequest === 'function'
    ? 'xhr'
    : 'stream';
}

/** The route, and for `native-xhr` the body as the caller built it when the transport receives it inside a `Request`. */
export interface UploadProgressDelivery {
  readonly route: UploadProgressRoute;
  readonly nativeBody?: XMLHttpRequestBodyInit | null;
}

/** Reports of one attempt: the first is `0`, and each later one only when it grew. */
function reporter(
  listener: UploadProgressListener,
  attempt: number,
): (sentBytes: number, totalBytes: number) => void {
  let reported = -1;
  const emit = (sentBytes: number, totalBytes: number): void => {
    reported = sentBytes;
    try {
      listener({ sentBytes, totalBytes, attempt });
    } catch {
      // A progress view that throws must not fail the upload it is drawing.
    }
  };
  return (sentBytes, totalBytes) => {
    if (sentBytes <= reported) return;
    if (reported < 0 && sentBytes > 0) emit(0, totalBytes);
    emit(sentBytes, totalBytes);
  };
}

export function withUploadProgress(
  transport: ClientFetch,
  listener: UploadProgressListener,
  delivery: UploadProgressDelivery,
): ClientFetch {
  let attempts = 0;
  return async (input, init) => {
    attempts += 1;
    const report = reporter(listener, attempts);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const credentials =
      init?.credentials ?? (input instanceof Request ? input.credentials : undefined);
    if (delivery.route === 'native-xhr') {
      return sendNative(input, init, delivery.nativeBody ?? xhrBodyOf(init?.body), {
        signal,
        credentials,
        report,
      });
    }
    const request = new Request(input, init);
    // Copied before the body is read: Bun forgets a multipart boundary header
    // once the body it describes has been consumed.
    const headers = new Headers(request.headers);
    const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(await request.arrayBuffer());
    const total = bytes.byteLength;
    report(0, total);
    if (delivery.route === 'xhr') {
      if (credentials === 'omit') {
        throw new TypeError(
          "onUploadProgress sends through XMLHttpRequest, which cannot omit same-origin cookies — use credentials 'same-origin' or 'include'",
        );
      }
      return sendThroughXhr({
        method: request.method,
        url: request.url,
        headers,
        body: total > 0 ? bytes : null,
        totalBytes: total,
        withCredentials: credentials === 'include',
        signal,
        report,
      });
    }
    headers.set('content-length', String(total));
    const counted =
      total > 0
        ? { body: countedBody(bytes, (sent) => report(sent, total)), duplex: 'half' }
        : {};
    const outgoing: RequestInit = {
      ...init,
      method: request.method,
      headers,
      body: undefined,
      ...counted,
      ...(signal && { signal }),
      ...(credentials && { credentials }),
    };
    return transport(request.url, outgoing);
  };
}

/** The body in pieces, each counted as the transport pulls it; nothing is read ahead. */
function countedBody(
  bytes: Uint8Array,
  report: (sentBytes: number) => void,
): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(offset + PIECE_BYTES, bytes.byteLength);
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
        report(offset);
      },
    },
    { highWaterMark: 0 },
  );
}

interface NativeSend {
  readonly signal: AbortSignal | null | undefined;
  readonly credentials: RequestCredentials | undefined;
  readonly report: (sentBytes: number, totalBytes: number) => void;
}

/**
 * React Native: the body as built, through the platform XHR. Its size is known
 * up front for a string or bytes; a `FormData`'s comes with the first upload
 * event. Credentials follow React Native's own fetch: `include` and `omit` set
 * `withCredentials`, anything else keeps the platform default.
 */
function sendNative(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  body: XMLHttpRequestBodyInit | null,
  { signal, credentials, report }: NativeSend,
): Promise<Response> {
  const request = input instanceof Request ? input : undefined;
  const headers = new Headers(request?.headers);
  new Headers(init?.headers).forEach((value, name) => {
    headers.set(name, value);
  });
  // A `FormData` is encoded by the platform, which writes its own boundary; a
  // header left from a `Request` built around it would name another one.
  if (body instanceof FormData) headers.delete('content-type');
  const totalBytes = knownLength(body);
  if (totalBytes !== undefined) report(0, totalBytes);
  return sendThroughXhr({
    method: init?.method ?? request?.method ?? 'GET',
    url: request?.url ?? String(input),
    headers,
    body,
    totalBytes,
    ...(credentials === 'include' && { withCredentials: true }),
    ...(credentials === 'omit' && { withCredentials: false }),
    signal,
    report,
  });
}

function xhrBodyOf(body: BodyInit | null | undefined): XMLHttpRequestBodyInit | null {
  if (body instanceof ReadableStream) {
    throw new TypeError('onUploadProgress in React Native cannot send a streamed body');
  }
  return body ?? null;
}

function knownLength(body: XMLHttpRequestBodyInit | null): number | undefined {
  if (body === null) return 0;
  if (typeof body === 'string') return new TextEncoder().encode(body).byteLength;
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength;
  return undefined;
}

interface XhrSend {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: XMLHttpRequestBodyInit | null;
  /** Unknown until the first upload event when the platform encodes the body. */
  readonly totalBytes: number | undefined;
  /** Left at the platform default when absent. */
  readonly withCredentials?: boolean;
  readonly signal: AbortSignal | null | undefined;
  readonly report: (sentBytes: number, totalBytes: number) => void;
}

/** Headers a browser sets itself and refuses from a script. */
const BROWSER_OWNED_HEADERS = new Set(['content-length', 'host', 'connection']);

function sendThroughXhr(send: XhrSend): Promise<Response> {
  const { signal, report } = send;
  let total = send.totalBytes;
  const progress = (loaded: number, eventTotal: number): void => {
    if (total === undefined && eventTotal > 0) total = eventTotal;
    if (total !== undefined) report(Math.min(loaded, total), total);
  };
  const finished = (): void => {
    if (total !== undefined) report(total, total);
  };
  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open(send.method, send.url, true);
    send.headers.forEach((value, name) => {
      if (!BROWSER_OWNED_HEADERS.has(name)) xhr.setRequestHeader(name, value);
    });
    if (send.withCredentials !== undefined) xhr.withCredentials = send.withCredentials;
    xhr.responseType = 'arraybuffer';
    const abort = (): void => xhr.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const settle = (): void => signal?.removeEventListener('abort', abort);
    xhr.upload.onprogress = (event) => progress(event.loaded, event.total);
    xhr.upload.onload = finished;
    xhr.onload = () => {
      settle();
      // Status 0 is how a browser reports a response it would not expose.
      if (xhr.status < 200 || xhr.status > 599) {
        reject(new TypeError('Network request failed'));
        return;
      }
      finished();
      resolve(responseOf(xhr));
    };
    xhr.onerror = () => {
      settle();
      reject(new TypeError('Network request failed'));
    };
    xhr.onabort = () => {
      settle();
      reject(signal ? abortReason(signal) : new DOMException('Aborted', 'AbortError'));
    };
    xhr.send(send.body);
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

/** Statuses whose response must be constructed without a body. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

function responseOf(xhr: XMLHttpRequest): Response {
  const headers = new Headers();
  for (const line of xhr
    .getAllResponseHeaders()
    .trim()
    .split(/[\r\n]+/)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  const body: unknown = xhr.response;
  return new Response(
    NULL_BODY_STATUSES.has(xhr.status) || !(body instanceof ArrayBuffer) ? null : body,
    { status: xhr.status, statusText: xhr.statusText, headers },
  );
}
