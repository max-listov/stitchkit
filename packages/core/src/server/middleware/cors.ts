export interface CorsConfig {
  origin?: string | string[];
  credentials?: boolean;
  methods?: string;
  headers?: string;
}

export function corsHeaders(
  config: CorsConfig,
  requestOrigin?: string | null,
): Record<string, string> {
  // Resolve the allowed origin. `undefined` → omit the header entirely; an
  // empty string is never emitted (it is an invalid header value).
  let allowOrigin: string | undefined;
  if (config.origin === undefined || config.origin === '*') {
    // `Allow-Origin: *` is invalid with credentials — reflect the caller's
    // origin instead so credentialed requests still work.
    allowOrigin = config.credentials ? (requestOrigin ?? undefined) : '*';
  } else if (Array.isArray(config.origin)) {
    allowOrigin =
      requestOrigin && config.origin.includes(requestOrigin) ? requestOrigin : undefined;
  } else {
    allowOrigin = config.origin;
  }

  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': config.methods ?? 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      config.headers ?? 'Content-Type, Authorization, X-Trace-Id',
  };
  if (allowOrigin !== undefined) {
    headers['Access-Control-Allow-Origin'] = allowOrigin;
  }
  if (config.credentials) {
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  // The chosen origin depends on the request whenever it is whitelisted from a
  // list or reflected for credentials — tell shared caches, match or not.
  const variesByOrigin =
    Array.isArray(config.origin) ||
    ((config.origin === undefined || config.origin === '*') && Boolean(config.credentials));
  if (variesByOrigin) {
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
