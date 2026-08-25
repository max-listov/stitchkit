import { internalApiUrl } from '@/lib/api/place';

/**
 * The default shape: the browser talks to its OWN origin, and the web role
 * forwards to the API role.
 *
 * This is what makes the example's client a plain module constant. A browser
 * that dials the API role directly needs that role's public address, which is a
 * property of the place — so the address has to arrive from the server at
 * runtime, the client cannot exist until it does, and every call site pays for
 * that with a lazy accessor. A same-origin request needs no address at all:
 * `/api/…` is complete before any machine exists.
 *
 * What it costs: one extra hop through the web role, and no WebSocket — a
 * route handler cannot proxy an upgrade. The realtime socket is therefore the
 * one place this example still needs the API role's address, or a routing layer
 * in front of both roles that serves them on one origin (see
 * `lib/api/cross-origin.ts`).
 */
export const dynamic = 'force-dynamic';

const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'content-type',
  'authorization',
];
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'cache-control', 'etag'];

async function forward(request: Request): Promise<Response> {
  const incoming = new URL(request.url);
  // Rebuilt from the incoming pathname rather than from the matched segments,
  // so an encoded segment reaches the API role exactly as it arrived.
  const target = new URL(`${incoming.pathname}${incoming.search}`, internalApiUrl());

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  // Buffered rather than streamed: forwarding a stream needs the non-standard
  // `duplex` init that this project's types do not carry, and every payload
  // this contract accepts is a small JSON document.
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const response = await fetch(target, {
    method: request.method,
    headers,
    body: hasBody ? await request.arrayBuffer() : undefined,
    // A redirect is the API role's answer, not something to resolve here.
    redirect: 'manual',
  });

  const responseHeaders = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) responseHeaders.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers: responseHeaders });
}

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
