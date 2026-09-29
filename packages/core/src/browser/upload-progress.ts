/**
 * Upload progress for one client call: a delivery wrapper that encodes the
 * request body once and reports how much of it has gone out.
 *
 * Fetch has no upload event, so the count comes from one of two places:
 *
 * - **stream** (Bun, Node, an injected fetch, a unix socket): the encoded
 *   body leaves as a `ReadableStream` the transport pulls in 64 KiB pieces,
 *   with an exact `content-length`. A piece counts when the transport takes it.
 * - **xhr** (a browser on its own fetch): `XMLHttpRequest.upload` events, the
 *   only upload signal every browser has — a streaming request body needs
 *   HTTP/2 in Chromium and does not exist in Safari.
 *
 * Every call of the wrapper is one attempt, so a transport retry starts the
 * count again under the next attempt number.
 */

import type { UploadProgress } from '../contract/client-types';
import type { ClientFetch } from './transport';

type UploadProgressListener = (progress: UploadProgress) => void;

/** Where upload bytes are counted. */
export type UploadProgressRoute = 'stream' | 'xhr';

const PIECE_BYTES = 64 * 1024;

/** A browser's own fetch counts through XHR; anything injected or non-browser streams. */
export function uploadProgressRoute(injectedTransport: boolean): UploadProgressRoute {
  return !injectedTransport && typeof globalThis.XMLHttpRequest === 'function'
    ? 'xhr'
    : 'stream';
}

export function withUploadProgress(
  transport: ClientFetch,
  listener: UploadProgressListener,
  route: UploadProgressRoute,
): ClientFetch {
  let attempts = 0;
  return async (input, init) => {
    attempts += 1;
    const attempt = attempts;
    const request = new Request(input, init);
    // Copied before the body is read: Bun forgets a multipart boundary header
    // once the body it describes has been consumed.
    const headers = new Headers(request.headers);
    const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(await request.arrayBuffer());
    let reported = -1;
    const report = (sentBytes: number): void => {
      if (sentBytes <= reported) return;
      reported = sentBytes;
      try {
        listener({ sentBytes, totalBytes: bytes.byteLength, attempt });
      } catch {
        // A progress view that throws must not fail the upload it is drawing.
      }
    };
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const credentials =
      init?.credentials ?? (input instanceof Request ? input.credentials : undefined);
    report(0);
    if (route === 'xhr') {
      return sendThroughXhr(request, headers, bytes, { signal, credentials, report });
    }
    headers.set('content-length', String(bytes.byteLength));
    const counted =
      bytes.byteLength > 0 ? { body: countedBody(bytes, report), duplex: 'half' } : {};
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

interface XhrSend {
  readonly signal: AbortSignal | null | undefined;
  readonly credentials: RequestCredentials | undefined;
  readonly report: (sentBytes: number) => void;
}

/** Headers a browser sets itself and refuses from a script. */
const BROWSER_OWNED_HEADERS = new Set(['content-length', 'host', 'connection']);

function sendThroughXhr(
  request: Request,
  headers: Headers,
  bytes: Uint8Array<ArrayBuffer>,
  { signal, credentials, report }: XhrSend,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    if (credentials === 'omit') {
      reject(
        new TypeError(
          "onUploadProgress sends through XMLHttpRequest, which cannot omit same-origin cookies — use credentials 'same-origin' or 'include'",
        ),
      );
      return;
    }
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open(request.method, request.url, true);
    headers.forEach((value, name) => {
      if (!BROWSER_OWNED_HEADERS.has(name)) xhr.setRequestHeader(name, value);
    });
    xhr.withCredentials = credentials === 'include';
    xhr.responseType = 'arraybuffer';
    const abort = (): void => xhr.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const settle = (): void => signal?.removeEventListener('abort', abort);
    xhr.upload.onprogress = (event) => report(Math.min(event.loaded, bytes.byteLength));
    xhr.upload.onload = () => report(bytes.byteLength);
    xhr.onload = () => {
      settle();
      // Status 0 is how a browser reports a response it would not expose.
      if (xhr.status < 200 || xhr.status > 599) {
        reject(new TypeError('Network request failed'));
        return;
      }
      report(bytes.byteLength);
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
    xhr.send(bytes.byteLength > 0 ? bytes : null);
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
