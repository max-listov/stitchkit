export interface CorsConfig {
  origin?: string | string[];
  credentials?: boolean;
  methods?: string;
  headers?: string;
  /**
   * Response headers a cross-origin caller is allowed to *read*
   * (`Access-Control-Expose-Headers`). Defaults to
   * {@link DEFAULT_CORS_EXPOSE_HEADERS}; pass `[]` to emit none.
   */
  exposeHeaders?: string | string[];
}

/**
 * The default `Access-Control-Allow-Headers` — the request headers stitchkit's
 * own clients send, so a browser preflight passes out of the box. The single
 * source shared by the HTTP server and the tool/OAuth CORS handlers (they used
 * to carry three divergent literals).
 *
 * - `Content-Type` / `Authorization` — bodies and bearer auth.
 * - `X-Trace-Id` — the simple inbound trace id (`resolveTraceId` reads it).
 * - `traceparent` / `tracestate` — W3C Trace Context, what
 *   `createHttpClient({ trace: true })` emits on every request; without it that
 *   feature dies on the cross-origin preflight.
 */
export const DEFAULT_CORS_ALLOW_HEADERS =
  'Content-Type, Authorization, X-Trace-Id, traceparent, tracestate';

/**
 * The default `Access-Control-Expose-Headers`. Without it a cross-origin
 * `fetch` can read only the CORS-safelisted response headers, so a browser
 * downloading a file cannot recover its name (`Content-Disposition`), and a
 * client cannot revalidate (`ETag`) or resume (`Content-Range`) — the very
 * headers `serveFile` exists to emit.
 *
 * An explicit list rather than `*`, because the wildcard is ignored whenever
 * the request carries credentials — exactly the authenticated download case.
 * These are headers the server already chose to send; exposing them reveals
 * nothing new. Opt out with `exposeHeaders: []`.
 *
 * `X-Request-Id` is the trace id a response carries whenever its headers can be
 * written — the id a browser client quotes in a bug report and the one a reverse
 * proxy logs. Not *every* response: `create.ts` skips the write on immutable
 * headers rather than throwing, which a redirect built by `Response.redirect`
 * has, so a client correlating by this header loses the trace across one.
 * Note the deliberate asymmetry with {@link DEFAULT_CORS_ALLOW_HEADERS}:
 * inbound the id may arrive as `X-Trace-Id`, outbound it is always
 * `X-Request-Id` — one name on the wire out, no alias.
 */
export const DEFAULT_CORS_EXPOSE_HEADERS =
  'Content-Disposition, Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified, X-Request-Id';

/**
 * Reject an unsafe CORS config at construction. `credentials: true` with a
 * wildcard origin would reflect *any* caller's `Origin` with
 * `Allow-Credentials: true` — every site could make authenticated cross-origin
 * requests. Credentials require an explicit origin allow-list.
 */
export function assertCorsConfig(config: CorsConfig): void {
  if (config.credentials && (config.origin === undefined || config.origin === '*')) {
    throw new Error(
      '[stitchkit] cors: `credentials: true` cannot be combined with a wildcard origin. ' +
        'Set `origin` to an explicit string or list.',
    );
  }
  // A security-affecting setting must never pick the MOST permissive behaviour
  // because a value went missing — an env var marked optional would silently
  // open the API to every origin. "Allow all" is an explicit '*', not a hole.
  if (config.origin === undefined) {
    throw new Error(
      "[stitchkit] cors: `origin` is required. Pass an explicit origin (or list), or '*' to deliberately allow every origin — omit `cors` entirely to emit no CORS headers.",
    );
  }
  if (Array.isArray(config.origin) && config.origin.length === 0) {
    throw new Error(
      "[stitchkit] cors: `origin` cannot be an empty list. Pass explicit origins, or '*' to deliberately allow every origin.",
    );
  }
}

/** Resolve the allowed origin for a request — `undefined` means emit no header. */
function resolveOrigin(
  config: CorsConfig,
  requestOrigin: string | null | undefined,
): string | undefined {
  // A missing origin emits NO header — `assertCorsConfig` rejects it up
  // front, and any path that skips the assertion must still fail safe rather
  // than fall open to a wildcard.
  if (config.origin === undefined) return undefined;
  if (config.origin === '*') {
    // Credentials + wildcard is rejected by `assertCorsConfig`, so a wildcard
    // here is always credential-free and safe to emit verbatim.
    return '*';
  }
  if (Array.isArray(config.origin)) {
    if (!requestOrigin) return undefined;
    const lower = requestOrigin.toLowerCase();
    return config.origin.some((o) => o.toLowerCase() === lower) ? requestOrigin : undefined;
  }
  return config.origin;
}

export function corsHeaders(
  config: CorsConfig,
  requestOrigin?: string | null,
): Record<string, string> {
  const allowOrigin = resolveOrigin(config, requestOrigin);

  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods':
      config.methods ?? 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': config.headers ?? DEFAULT_CORS_ALLOW_HEADERS,
  };
  const expose = Array.isArray(config.exposeHeaders)
    ? config.exposeHeaders.join(', ')
    : (config.exposeHeaders ?? DEFAULT_CORS_EXPOSE_HEADERS);
  if (expose !== '') {
    headers['Access-Control-Expose-Headers'] = expose;
  }
  if (allowOrigin !== undefined) {
    headers['Access-Control-Allow-Origin'] = allowOrigin;
    // Credentials are emitted only alongside a resolved origin — never on a
    // request whose origin was rejected.
    if (config.credentials) {
      headers['Access-Control-Allow-Credentials'] = 'true';
    }
  }
  // The chosen origin depends on the request whenever it is whitelisted from a
  // list — tell shared caches the response varies by `Origin`.
  if (Array.isArray(config.origin)) {
    headers.Vary = 'Origin';
  }
  return headers;
}

export function corsPreflightResponse(config: CorsConfig, req: Request): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(config, req.headers.get('origin')),
  });
}
