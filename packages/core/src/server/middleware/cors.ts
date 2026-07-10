export interface CorsConfig {
  origin?: string | string[];
  credentials?: boolean;
  methods?: string;
  headers?: string;
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
}

/** Resolve the allowed origin for a request — `undefined` means emit no header. */
function resolveOrigin(
  config: CorsConfig,
  requestOrigin: string | null | undefined,
): string | undefined {
  if (config.origin === undefined || config.origin === '*') {
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
    'Access-Control-Allow-Methods': config.methods ?? 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': config.headers ?? DEFAULT_CORS_ALLOW_HEADERS,
  };
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
