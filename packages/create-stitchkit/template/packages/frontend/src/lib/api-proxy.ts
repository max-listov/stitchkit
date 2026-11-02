/**
 * What crosses the web role on the way to the API role.
 *
 * An allow-list on purpose: the web role is not a transparent proxy, and a
 * header nobody named stays out. Each name below is what some path of the API
 * needs. `cookie` and `origin` carry a session and its CSRF check, `set-cookie`
 * opens that session, `content-disposition`, `content-length` and the range and
 * validator pairs make a file a resumable download with its name, and
 * `retry-after` and `www-authenticate` are what a refusal tells its client.
 */
const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'content-type',
  'authorization',
  'cookie',
  'origin',
  'range',
  'if-none-match',
  'if-modified-since',
];
const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'cache-control',
  'etag',
  'last-modified',
  'content-disposition',
  'content-range',
  'accept-ranges',
  'retry-after',
  'www-authenticate',
  'x-request-id',
];

/** The browser has never heard of the internal address, and a bad header is not this role's. */
function publicLocation(location: string, apiUrl: string): string {
  if (!URL.canParse(location, apiUrl)) return location;
  const redirect = new URL(location, apiUrl);
  return redirect.origin === new URL(apiUrl).origin
    ? `${redirect.pathname}${redirect.search}${redirect.hash}`
    : location;
}

export async function forwardToApi(request: Request, apiUrl: string): Promise<Response> {
  const incoming = new URL(request.url);
  // Rebuilt from the incoming pathname rather than from the matched segments,
  // so an encoded segment reaches the API role exactly as it arrived.
  const target = new URL(`${incoming.pathname}${incoming.search}`, apiUrl);

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  // Streamed, so an upload is not held in this role. `duplex` is required with a
  // stream body and absent from the DOM's `RequestInit`. The signal ends the API
  // role's work, a stream included, when the browser goes away.
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    signal: request.signal,
    // A redirect is the API role's answer, not something to resolve here.
    redirect: 'manual',
  };
  if (request.body) {
    init.body = request.body;
    init.duplex = 'half';
  }
  const response = await fetch(target, init);

  const responseHeaders = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) responseHeaders.set(name, value);
  }
  const location = response.headers.get('location');
  if (location !== null) responseHeaders.set('location', publicLocation(location, apiUrl));
  // One header per cookie: joined by a comma they stop being cookies.
  for (const cookie of response.headers.getSetCookie()) {
    responseHeaders.append('set-cookie', cookie);
  }
  // `fetch` has already decoded a compressed body, so its length is not this one.
  const length = response.headers.get('content-length');
  if (length !== null && !response.headers.has('content-encoding')) {
    responseHeaders.set('content-length', length);
  }
  return new Response(response.body, { status: response.status, headers: responseHeaders });
}
