import { z } from 'zod';

/** Static Cross-Origin Resource Sharing (CORS) header configuration for a handler. */
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
 * What an origin resolver answers for one exact origin: an allowance with or
 * without credentials, or `false` for none.
 */
export type CorsOriginDecision = false | { credentials: boolean };

/**
 * A CORS policy decided per request: the application looks the origin up —
 * in a database, a key's allowed origins — and answers for that origin alone.
 *
 * Credentials are part of the answer, never a flag beside it: one origin can be
 * the application's own page with cookies while another holds a short bearer
 * token and gets none. The grant names the requesting origin exactly; a resolver
 * cannot answer with another origin or `*`. It is called only with a serialized
 * origin (scheme and authority), never with `null` or a missing header, and a
 * throw, a rejection or an answer of another shape grants nothing.
 */
export interface CorsOriginPolicy
  extends Pick<CorsConfig, 'methods' | 'headers' | 'exposeHeaders'> {
  origin: (origin: string) => CorsOriginDecision | Promise<CorsOriginDecision>;
  /** Decided per origin by `origin`; a flag here would be a second answer. */
  credentials?: never;
}

/**
 * The CORS answer for one request, decided once before any work and read by
 * every exit — preflight, `onRequest`, raw routes, every endpoint response and
 * every error — so the same request never gets two answers.
 */
export interface RequestCors {
  readonly headers: Readonly<Record<string, string>>;
  /**
   * Whether this request's origin may send a safelisted `text/plain` body
   * (ADR 0165): there is no allow-list at all, the origin is allowed, or it is not.
   */
  readonly safelistedBody: 'no-allow-list' | 'allowed' | 'refused';
}

const CorsOriginDecisionSchema = z.union([
  z.literal(false),
  z.object({ credentials: z.boolean() }).strict(),
]);

function isOriginPolicy(config: CorsConfig | CorsOriginPolicy): config is CorsOriginPolicy {
  return typeof config.origin === 'function';
}

/** Scheme and authority, as a browser serializes `Origin`; `null` and junk are not origins. */
function isSerializedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.host !== '' && origin === `${url.protocol}//${url.host}`;
  } catch {
    return false;
  }
}

/**
 * Decide CORS for one request. A static config answers synchronously, so a
 * handler without a policy keeps its timing; a policy asks the application. A
 * failing policy throws or rejects, and the caller answers with
 * {@link deniedRequestCors}.
 */
export function resolveRequestCors(
  config: CorsConfig | CorsOriginPolicy,
  origin: string | null,
): RequestCors | Promise<RequestCors> {
  if (!isOriginPolicy(config)) {
    return {
      headers: corsHeaders(config, origin),
      safelistedBody:
        config.origin === undefined || config.origin === '*'
          ? 'no-allow-list'
          : isOriginAllowed(config, origin)
            ? 'allowed'
            : 'refused',
    };
  }
  if (!origin || !isSerializedOrigin(origin)) return deniedRequestCors(config);
  return askPolicy(config, origin);
}

async function askPolicy(config: CorsOriginPolicy, origin: string): Promise<RequestCors> {
  const parsed = CorsOriginDecisionSchema.safeParse(await config.origin(origin));
  if (!parsed.success) {
    throw new TypeError(
      '[stitchkit] cors: an origin resolver must answer false or { credentials: boolean }',
    );
  }
  if (parsed.data === false) return deniedRequestCors(config);
  return {
    headers: {
      ...permissionHeaders(config, origin, parsed.data.credentials),
      Vary: 'Origin',
    },
    // A simple request is sent with cookies before CORS is consulted; only an
    // origin trusted with credentials may have its text body read.
    safelistedBody: parsed.data.credentials ? 'allowed' : 'refused',
  };
}

/** No allowance: the shared headers without an origin, varying by `Origin` for caches. */
export function deniedRequestCors(
  config: Pick<CorsConfig, 'methods' | 'headers' | 'exposeHeaders'>,
): RequestCors {
  return {
    headers: { ...permissionHeaders(config, undefined, false), Vary: 'Origin' },
    safelistedBody: 'refused',
  };
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
 * - `X-Stitchkit-Timeout-Ms` — relative remaining deadline budget propagated by
 *   `createClient` / `createHttpClient`.
 */
export const DEFAULT_CORS_ALLOW_HEADERS =
  'Content-Type, Authorization, X-Trace-Id, traceparent, tracestate, X-Stitchkit-Timeout-Ms';

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
 *
 * `X-Build-Id` is the release a handler configured with a release marker
 * names on every response; a cross-origin page reads it to learn it is stale
 * (`stitchkit/release`).
 */
export const DEFAULT_CORS_EXPOSE_HEADERS =
  'Content-Disposition, Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified, X-Request-Id, X-Build-Id';

/**
 * Reject an unsafe CORS config at construction. `credentials: true` with a
 * wildcard origin would reflect *any* caller's `Origin` with
 * `Allow-Credentials: true` — every site could make authenticated cross-origin
 * requests. Credentials require an explicit origin allow-list.
 */
export function assertCorsConfig(config: CorsConfig | CorsOriginPolicy): void {
  if (isOriginPolicy(config)) {
    if (config.credentials !== undefined) {
      throw new Error(
        '[stitchkit] cors: an origin resolver decides credentials per origin; remove `credentials`.',
      );
    }
    return;
  }
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

/**
 * Is `requestOrigin` on the server's **explicit** allow-list? The question a
 * safelisted request body asks before it is read (→ ADR 0165), and it is
 * deliberately stricter than `resolveOrigin`: a wildcard is not an allow-list
 * (a simple request is sent with cookies from any site, so `'*'` would admit
 * every site), `null` is what a sandboxed iframe, a cross-origin redirect and
 * `file://` send and names no site, and an absent header is no answer at all.
 * A string origin is compared, not echoed. Case-insensitive, like
 * `resolveOrigin`'s list branch.
 */
export function isOriginAllowed(
  config: CorsConfig | undefined,
  requestOrigin: string | null | undefined,
): boolean {
  if (!config || config.origin === undefined || config.origin === '*') return false;
  if (!requestOrigin || requestOrigin === 'null') return false;
  const lower = requestOrigin.toLowerCase();
  const allowed = Array.isArray(config.origin) ? config.origin : [config.origin];
  return allowed.some((origin) => origin.toLowerCase() === lower);
}

export function corsHeaders(
  config: CorsConfig,
  requestOrigin?: string | null,
): Record<string, string> {
  const headers = permissionHeaders(
    config,
    resolveOrigin(config, requestOrigin),
    config.credentials === true,
  );
  // The chosen origin depends on the request whenever it is whitelisted from a
  // list — tell shared caches the response varies by `Origin`.
  if (Array.isArray(config.origin)) {
    headers.Vary = 'Origin';
  }
  return headers;
}

function permissionHeaders(
  config: Pick<CorsConfig, 'methods' | 'headers' | 'exposeHeaders'>,
  allowOrigin: string | undefined,
  credentials: boolean,
): Record<string, string> {
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
    if (credentials) {
      headers['Access-Control-Allow-Credentials'] = 'true';
    }
  }
  return headers;
}

export function corsPreflightResponse(config: CorsConfig, req: Request): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(config, req.headers.get('origin')),
  });
}

/** The CORS headers for one request — none when the handler has no CORS config. */
export function requestCorsHeaders(cors: RequestCors | undefined): Record<string, string> {
  return cors ? { ...cors.headers } : {};
}

/**
 * Apply CORS headers to a response produced outside the framework (a raw route,
 * a binary endpoint or an `onError` hook).
 *
 * Headers are mutated **in place**. Rebuilding with `new Response(res.body, …)`
 * silently corrupts partial responses: on Bun, reading `.body` of a response
 * built from `Bun.file().slice()` re-reads the *whole* file, so a `206` keeps
 * its honest `Content-Range` and `Content-Length` while the payload becomes the
 * entire file — a client stitching ranges gets garbage.
 *
 * A rebuild survives only as the fallback: WHATWG marks `Response.redirect()`
 * headers immutable (Node throws; Bun currently allows the set), and a redirect
 * has no body to corrupt.
 */
export function applyCors(res: Response, cors: RequestCors | undefined): Response {
  const extra = requestCorsHeaders(cors);
  if (Object.keys(extra).length === 0) return res;
  try {
    for (const [key, value] of Object.entries(extra)) setCorsHeader(res.headers, key, value);
    return res;
  } catch {
    const headers = new Headers(res.headers);
    for (const [key, value] of Object.entries(extra)) setCorsHeader(headers, key, value);
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  }
}

/**
 * `Vary` is a list the handler may already contribute to (a file response
 * carrying `Vary: Accept-Encoding`); overwriting it with `Origin` would make a
 * shared cache serve one encoding to everyone. Every other CORS header is
 * single-valued and ours alone, so it is set.
 */
function setCorsHeader(headers: Headers, key: string, value: string): void {
  if (key !== 'Vary') {
    headers.set(key, value);
    return;
  }
  const existing = headers.get('Vary');
  if (existing === null || existing.trim() === '') {
    headers.set('Vary', value);
    return;
  }
  const present = existing.split(',').some((field) => field.trim().toLowerCase() === 'origin');
  if (!present) headers.set('Vary', `${existing}, ${value}`);
}
