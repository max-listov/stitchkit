/**
 * One hop over a socket opened to the address the guard validated.
 *
 * The address is given, never looked up here: that is what makes a validated
 * answer the one the connection uses. The `Host` header keeps the URL's host
 * and, over TLS, the certificate is verified against it (`servername`), so a
 * pinned connection is not a weaker one. The body is a Fetch stream over the
 * socket, with backpressure and cancellation preserved.
 */
import type { IncomingMessage } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/** One hop, already resolved: open the connection to exactly `address`. */
export type PinnedTransport = (
  url: URL,
  resolved: { address: string; family: 4 | 6 },
  signal: AbortSignal | undefined,
) => Promise<Response>;

/**
 * One hop over a socket opened to `resolved.address`: the `Host` header keeps
 * the URL's host and, for TLS, the certificate is verified against it
 * (`servername`), so a pinned connection is not a weaker connection.
 */
export async function requestPinned(
  url: URL,
  resolved: { address: string; family: 4 | 6 },
  signal: AbortSignal | undefined,
  headers: Record<string, string> = {},
): Promise<Response> {
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const incoming = await new Promise<IncomingMessage>((resolve, reject) => {
    // A cancelled redirect destroys the socket on purpose: its later `error` is
    // the consequence of our own cancel, not a failure of this hop.
    let answered = false;
    const request = transport(
      {
        protocol: url.protocol,
        hostname: resolved.address,
        family: resolved.family,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        signal,
        ...(url.protocol === 'https:' ? { servername: url.hostname } : {}),
        headers: { host: url.host, accept: '*/*', ...headers },
      },
      (response) => {
        answered = true;
        resolve(response);
      },
    );
    request.once('error', (error: Error) => {
      if (answered) return;
      // A deadline or a caller's cancel must arrive as the reason it was given,
      // not as the socket's own "operation was aborted".
      reject(signal?.aborted && signal.reason !== undefined ? signal.reason : error);
    });
    request.end();
  });
  return pinnedResponse(incoming);
}

/** An `IncomingMessage` as a streaming Fetch response, keeping backpressure and cancellation. */
export function pinnedResponse(incoming: IncomingMessage): Response {
  const status = incoming.statusCode ?? 0;
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  // A status that forbids a body must not be given one, or `Response` throws.
  if (status === 204 || status === 205 || status === 304) {
    incoming.resume();
    return new Response(null, { status, statusText: incoming.statusMessage, headers });
  }
  // One terminal state: `end`, an error and a cancel can race on the same socket.
  let done = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      incoming.on('data', (chunk: Uint8Array) => {
        if (done) return;
        controller.enqueue(chunk);
        // The reader is behind: stop the socket until `pull` asks for more.
        if ((controller.desiredSize ?? 1) <= 0) incoming.pause();
      });
      incoming.once('end', () => {
        if (done) return;
        done = true;
        controller.close();
      });
      incoming.once('error', (error: Error) => {
        if (done) return;
        done = true;
        controller.error(error);
      });
    },
    pull() {
      incoming.resume();
    },
    cancel() {
      done = true;
      incoming.destroy();
    },
  });
  return new Response(body, { status, statusText: incoming.statusMessage, headers });
}
