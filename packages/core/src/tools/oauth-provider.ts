/**
 * OAuth 2.1 authorization-server toolkit for MCP. Returns the `RawRoute`s an MCP
 * server needs to be a connectable remote — metadata discovery (RFC 8414),
 * Dynamic Client Registration (RFC 7591), the `/authorize` and `/token`
 * endpoints with PKCE (RFC 7636) and resource indicators (RFC 8707).
 *
 * The protocol mechanics live here; the domain plugs in through callbacks:
 * persistence (`clients` / `codes` / `refreshTokens`) and the user login/consent
 * step (`authorizeUser`). Access tokens are signed HS256 JWTs whose `aud` binds
 * them to one resource — validate them with `verifyJwt({ audience })`.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fetchPinnedDocument } from '../internal/secure-fetch';
import { isRecord } from '../internal/typed';
import { signJwt } from '../server/middleware/auth';
import { DEFAULT_CORS_ALLOW_HEADERS } from '../server/middleware/cors';
import { verifyPkce } from '../server/middleware/pkce';
import type { RawRoute } from '../server/types';

// ─── Domain-supplied stores & callbacks ──────────────────────────────────────

/**
 * OpenID Connect DCR `application_type` (SEP-837). A `native` client (desktop /
 * CLI) may register an `http` loopback redirect; a `web` client may not — the
 * mismatch is the usual cause of a `redirect_uri` rejection for CLI clients.
 */
export type ApplicationType = 'native' | 'web';

/** A client as registered via DCR. Public clients (PKCE) carry no secret. */
export interface RegisteredClient {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
  /** The `application_type` the client declared, when it declared one. */
  applicationType?: ApplicationType;
}

/** Metadata posted to `/register` (RFC 7591) before a client id is assigned. */
export interface ClientMetadata {
  redirectUris: string[];
  clientName?: string;
  tokenEndpointAuthMethod?: string;
  /** `native` (desktop / CLI, loopback allowed) or `web` (https only). */
  applicationType?: ApplicationType;
}

function isPlainDisplayCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return (
    codePoint !== undefined &&
    codePoint >= 0x20 &&
    codePoint !== 0x7f &&
    character !== '<' &&
    character !== '>'
  );
}

const CimdClientMetadataSchema = z.object({
  client_id: z.url(),
  redirect_uris: z.array(z.url()).min(1),
  client_name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((value) => Array.from(value).every(isPlainDisplayCharacter), {
      message: 'client_name must be plain display text',
    }),
  token_endpoint_auth_method: z.literal('none'),
  application_type: z.enum(['native', 'web']).optional(),
});

/** Validated Client ID Metadata Document (CIMD) wire shape. */
export type CimdClientMetadata = z.infer<typeof CimdClientMetadataSchema>;

export interface CimdFetchPolicy {
  /** Maximum metadata document size. Default 64 KiB. */
  maxBytes?: number;
  /** DNS, connection and response timeout. Default 5 seconds. */
  timeoutMs?: number;
  /** Redirect hops, each re-resolved and re-validated. Default 3. */
  maxRedirects?: number;
}

export interface CimdCachePolicy {
  /**
   * Maximum cache entries — positive and negative entries each get their OWN
   * pool of this size, so a flood of failing lookups cannot evict warmed
   * clients and warmed clients cannot reset a failing client's backoff.
   * Default 256.
   */
  maxEntries?: number;
  /** Freshness when the response carries no cache directives. Default 5 minutes. */
  defaultTtlMs?: number;
  /** Upper bound for origin-provided freshness. Default 1 hour. */
  maxTtlMs?: number;
  /** Short fail-closed cache for invalid/unavailable documents. Default 10 seconds. */
  negativeTtlMs?: number;
  /** Maximum uncached metadata resolutions per window, server-wide. Default 120. */
  maxResolutions?: number;
  /**
   * Maximum uncached resolutions per window for ONE `client_id` — a single
   * client whose document disables caching burns its own budget, not the
   * server's. Default 10.
   */
  maxResolutionsPerClient?: number;
  /** Resolution-rate window in milliseconds. Default 60 seconds. */
  resolutionWindowMs?: number;
}

/** Injectable CIMD network boundary. Production uses the pinned-IP implementation. */
export interface CimdFetchResponse {
  status: number;
  headers: Headers;
  body: Uint8Array;
  url: URL;
}

export interface CimdClientMetadataFetcher {
  fetch(url: URL, headers: Record<string, string>): Promise<CimdFetchResponse>;
}

export interface CimdCacheEvent {
  clientId: string;
  status: 'hit' | 'miss' | 'revalidated' | 'negative';
  freshnessMs?: number;
}

/** Build the production SSRF-safe, IP-pinned CIMD fetcher. */
export function createSecureClientMetadataFetcher(
  policy: CimdFetchPolicy = {},
): CimdClientMetadataFetcher {
  assertPositiveInteger('cimd.maxBytes', policy.maxBytes ?? DEFAULT_CIMD_MAX_BYTES);
  assertPositiveNumber('cimd.timeoutMs', policy.timeoutMs ?? DEFAULT_CIMD_TIMEOUT_MS);
  assertNonNegativeInteger('cimd.maxRedirects', policy.maxRedirects ?? 3);
  return {
    fetch: (url, headers) =>
      fetchPinnedDocument(url, {
        maxBytes: policy.maxBytes ?? DEFAULT_CIMD_MAX_BYTES,
        timeoutMs: policy.timeoutMs ?? DEFAULT_CIMD_TIMEOUT_MS,
        maxRedirects: policy.maxRedirects ?? 3,
        headers,
        requireHttps: true,
      }),
  };
}

export interface OAuthClientRegistrationConfig {
  /** Exact application-owned clients take precedence over network discovery. */
  preRegistered?: {
    get(clientId: string): Promise<RegisteredClient | null>;
  };
  /** URL-based metadata. Enabled with secure defaults when omitted. */
  cimd?:
    | false
    | {
        cache?: CimdCachePolicy;
        fetcher?: CimdClientMetadataFetcher;
        /** Cache/revalidation telemetry; metadata contents are never emitted. */
        onCacheEvent?: (event: CimdCacheEvent) => void;
      };
  /** Dynamic registration. Disabled when omitted or `false`. */
  dcr?:
    | false
    | {
        register(metadata: ClientMetadata): Promise<RegisteredClient>;
        get(clientId: string): Promise<RegisteredClient | null>;
      };
}

/** State persisted between `/authorize` and `/token`, keyed by the auth code. */
export interface AuthCodeData {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  /** Always `S256` — `/authorize` rejects any other method (OAuth 2.1, public client). */
  codeChallengeMethod: 'S256';
  resource: string;
  scope?: string;
  userId: string;
  expiresAt: number;
}

/** State persisted for a refresh token. */
export interface RefreshData {
  clientId: string;
  resource: string;
  scope?: string;
  userId: string;
}

/** The parsed `/authorize` request handed to the domain login/consent step. */
export interface AuthRequest {
  clientId: string;
  redirectUri: string;
  scope?: string;
  resource: string;
  state?: string;
  clientName?: string;
  clientOrigin?: string;
  applicationType?: ApplicationType;
  /** True only for an HTTP loopback redirect used by a native client. */
  isLoopbackRedirect: boolean;
}

export interface OAuthProviderConfig {
  /** Authorization-server issuer — its own origin, e.g. `https://api.example.com`. */
  issuer: string;
  /** HMAC secret used to sign access-token JWTs. */
  signingSecret: string;
  /** Canonical resource id (MCP URL) — the access-token `aud`. */
  resource: string;
  /** Access-token lifetime in seconds. Default `3600`. */
  accessTokenTtlSec?: number;
  /** Scopes advertised in server metadata. */
  scopesSupported?: string[];
  /** Path prefix for the OAuth endpoints. Default `/oauth`. */
  basePath?: string;

  /** Client discovery policy. Default: CIMD enabled, DCR disabled. */
  clientRegistration?: OAuthClientRegistrationConfig;
  /** Single-use authorization-code store. `take` must atomically read+delete. */
  codes: {
    save(code: string, data: AuthCodeData): Promise<void>;
    take(code: string): Promise<AuthCodeData | null>;
  };
  /** Optional refresh-token store. Omit to disable the refresh grant. */
  refreshTokens?: {
    save(token: string, data: RefreshData): Promise<void>;
    take(token: string): Promise<RefreshData | null>;
  };

  /**
   * Authenticate the user and capture consent for an `/authorize` request.
   * Return the authenticated user and exact approved scope subset, or a
   * `Response` to drive the browser through the domain's own login first.
   */
  authorizeUser(
    req: Request,
    authRequest: AuthRequest,
  ): Promise<{ userId: string; approvedScopes: readonly string[] } | Response>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PUBLIC_CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': DEFAULT_CORS_ALLOW_HEADERS,
};

const AS_METADATA_PATH = '/.well-known/oauth-authorization-server';
const AUTH_CODE_TTL_MS = 60_000;
const DEFAULT_CIMD_MAX_BYTES = 64 * 1024;
const DEFAULT_CIMD_TIMEOUT_MS = 5_000;

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

function assertPositiveNumber(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
}

type CimdCacheEntry =
  | {
      ok: true;
      client: RegisteredClient;
      expiresAt: number;
      etag?: string;
      lastModified?: string;
    }
  | { ok: false; message: string; expiresAt: number };

function absoluteClientUrl(clientId: string): URL | null {
  try {
    return new URL(clientId);
  } catch {
    return null;
  }
}

function assertCimdClientId(clientId: string): URL {
  const url = new URL(clientId);
  if (url.protocol !== 'https:') throw new Error('CIMD client_id must use https');
  if (url.username || url.password)
    throw new Error('CIMD client_id cannot contain credentials');
  if (url.hash) throw new Error('CIMD client_id cannot contain a fragment');
  if (url.search) throw new Error('CIMD client_id cannot contain a query');
  if (url.toString() !== clientId) {
    throw new Error('CIMD client_id must be an exact canonical URL');
  }
  return url;
}

/**
 * Parse `Age` per RFC 9111: a list (two proxies each appending) takes its
 * FIRST value; anything non-numeric or negative reads as absent — never NaN,
 * never extra staleness.
 */
function parseAgeSeconds(headers: Headers): number {
  const raw = headers.get('age');
  if (raw === null) return 0;
  const first = raw.split(',')[0]?.trim() ?? '';
  return /^\d+$/.test(first) ? Number(first) : 0;
}

export function responseFreshness(
  headers: Headers,
  policy: CimdCachePolicy,
  now: number,
): { freshnessMs: number; store: boolean } {
  const maxTtl = policy.maxTtlMs ?? 3_600_000;
  const cacheControl = headers.get('cache-control') ?? '';
  if (/(?:^|,)\s*no-store\s*(?:,|$)/i.test(cacheControl)) {
    return { freshnessMs: 0, store: false };
  }
  if (/(?:^|,)\s*no-cache\s*(?:,|$)/i.test(cacheControl)) {
    return { freshnessMs: 0, store: true };
  }
  const maxAge = cacheControl.match(/(?:^|,)\s*max-age=([^,\s]*)/i)?.[1];
  if (maxAge !== undefined) {
    // RFC 9111 §5.2: an unparseable freshness directive means ALREADY
    // EXPIRED — falling back to a default TTL would cache what the origin
    // explicitly failed to authorise.
    if (!/^\d+$/.test(maxAge)) return { freshnessMs: 0, store: true };
    const age = parseAgeSeconds(headers);
    return {
      freshnessMs: Math.max(0, Math.min(maxTtl, (Number(maxAge) - age) * 1_000)),
      store: true,
    };
  }
  const expires = headers.get('expires');
  if (expires !== null) {
    const expiresAt = Date.parse(expires);
    // RFC 9111 §5.3: an unparseable Expires is treated as already expired.
    if (!Number.isFinite(expiresAt)) return { freshnessMs: 0, store: true };
    const dateAt = Date.parse(headers.get('date') ?? '');
    const ageMs = parseAgeSeconds(headers) * 1_000;
    const lifetime = Number.isFinite(dateAt) ? expiresAt - dateAt : expiresAt - now;
    return {
      freshnessMs: Math.max(0, Math.min(maxTtl, lifetime - ageMs)),
      store: true,
    };
  }
  return { freshnessMs: Math.min(maxTtl, policy.defaultTtlMs ?? 300_000), store: true };
}

function safeClientName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const safe = Array.from(value).filter(isPlainDisplayCharacter).join('').trim().slice(0, 200);
  return safe || undefined;
}

function parseScopes(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.split(/\s+/u).filter(Boolean))];
}

function toRegisteredClient(metadata: CimdClientMetadata): RegisteredClient {
  return {
    clientId: metadata.client_id,
    redirectUris: metadata.redirect_uris,
    ...(metadata.client_name !== undefined && { clientName: metadata.client_name }),
    ...(metadata.application_type !== undefined && {
      applicationType: metadata.application_type,
    }),
  };
}

function isJsonContentType(value: string): boolean {
  const mediaType = value.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'application/json' || mediaType?.endsWith('+json') === true;
}

function createCimdResolver(options: {
  cache?: CimdCachePolicy;
  fetcher: CimdClientMetadataFetcher;
  now?: () => number;
  onCacheEvent?: (event: CimdCacheEvent) => void;
}) {
  const policy = options.cache ?? {};
  const now = options.now ?? Date.now;
  // Positive and negative entries live in SEPARATE pools with separate
  // budgets: a flood of unresolvable client_ids evicts only other negatives
  // (warmed clients stay warm), and a burst of successful resolutions cannot
  // reset a failing client's negative backoff.
  const positives = new Map<string, CimdCacheEntry & { ok: true }>();
  const negatives = new Map<string, CimdCacheEntry & { ok: false }>();
  const inflight = new Map<string, Promise<RegisteredClient>>();
  const maxEntries = policy.maxEntries ?? 256;
  const maxResolutions = policy.maxResolutions ?? 120;
  const maxResolutionsPerClient = policy.maxResolutionsPerClient ?? 10;
  const resolutionWindowMs = policy.resolutionWindowMs ?? 60_000;
  let resolutionWindowStartedAt = now();
  let resolutionsInWindow = 0;
  // Per-client windows, bounded so the tracker itself cannot be flooded.
  const clientWindows = new Map<string, { startedAt: number; count: number }>();
  const CLIENT_WINDOW_CAP = 4096;
  assertPositiveInteger('cimd.cache.maxEntries', maxEntries);
  assertPositiveInteger('cimd.cache.maxResolutions', maxResolutions);
  assertPositiveInteger('cimd.cache.maxResolutionsPerClient', maxResolutionsPerClient);
  assertPositiveInteger('cimd.cache.resolutionWindowMs', resolutionWindowMs);
  assertNonNegativeInteger('cimd.cache.defaultTtlMs', policy.defaultTtlMs ?? 300_000);
  assertNonNegativeInteger('cimd.cache.maxTtlMs', policy.maxTtlMs ?? 3_600_000);
  assertNonNegativeInteger('cimd.cache.negativeTtlMs', policy.negativeTtlMs ?? 10_000);
  const emit = (event: CimdCacheEvent): void => {
    try {
      options.onCacheEvent?.(event);
    } catch {
      // Cache telemetry must not alter authorization semantics.
    }
  };
  const readCache = (key: string): CimdCacheEntry | undefined =>
    positives.get(key) ?? negatives.get(key);
  const trimOldest = (pool: Map<string, unknown>): void => {
    while (pool.size > maxEntries) {
      const oldest = pool.keys().next().value;
      if (oldest === undefined) break;
      pool.delete(oldest);
    }
  };
  const touch = (key: string, value: CimdCacheEntry): void => {
    if (value.ok) {
      negatives.delete(key);
      positives.delete(key);
      positives.set(key, value);
      trimOldest(positives);
    } else {
      positives.delete(key);
      negatives.delete(key);
      negatives.set(key, value);
      trimOldest(negatives);
    }
  };
  const dropCache = (key: string): void => {
    positives.delete(key);
    negatives.delete(key);
  };

  const resolveOne = async (clientId: string): Promise<RegisteredClient> => {
    const url = assertCimdClientId(clientId);
    const cached = readCache(clientId);
    if (cached && cached.expiresAt > now()) {
      touch(clientId, cached);
      if (cached.ok) {
        emit({ clientId, status: 'hit', freshnessMs: cached.expiresAt - now() });
        return cached.client;
      }
      emit({ clientId, status: 'negative', freshnessMs: cached.expiresAt - now() });
      throw new Error(cached.message);
    }
    emit({ clientId, status: 'miss' });
    const currentTime = now();
    if (currentTime - resolutionWindowStartedAt >= resolutionWindowMs) {
      resolutionWindowStartedAt = currentTime;
      resolutionsInWindow = 0;
    }
    // The per-client budget is checked FIRST and neither counter moves on a
    // rejection — one greedy client (a `no-cache` document, a retry loop)
    // exhausts its own allowance, not the server-wide one, so a fresh
    // legitimate client still resolves inside the same window.
    let clientWindow = clientWindows.get(clientId);
    if (!clientWindow || currentTime - clientWindow.startedAt >= resolutionWindowMs) {
      clientWindow = { startedAt: currentTime, count: 0 };
      clientWindows.delete(clientId);
      clientWindows.set(clientId, clientWindow);
      while (clientWindows.size > CLIENT_WINDOW_CAP) {
        const oldest = clientWindows.keys().next().value;
        if (oldest === undefined) break;
        clientWindows.delete(oldest);
      }
    }
    if (clientWindow.count >= maxResolutionsPerClient) {
      throw new Error('CIMD metadata resolution rate limit exceeded for this client_id');
    }
    if (resolutionsInWindow >= maxResolutions) {
      throw new Error('CIMD metadata resolution rate limit exceeded');
    }
    clientWindow.count += 1;
    resolutionsInWindow += 1;

    const conditionalHeaders: Record<string, string> = {};
    if (cached?.ok && cached.etag) conditionalHeaders['if-none-match'] = cached.etag;
    if (cached?.ok && cached.lastModified) {
      conditionalHeaders['if-modified-since'] = cached.lastModified;
    }

    try {
      const response = await options.fetcher.fetch(url, conditionalHeaders);
      const freshness = responseFreshness(response.headers, policy, now());
      if (response.status === 304 && cached?.ok) {
        const refreshed: CimdCacheEntry = {
          ...cached,
          expiresAt: now() + freshness.freshnessMs,
        };
        if (freshness.store) touch(clientId, refreshed);
        else dropCache(clientId);
        emit({ clientId, status: 'revalidated', freshnessMs: freshness.freshnessMs });
        return refreshed.client;
      }
      if (response.status !== 200) {
        throw new Error(`CIMD endpoint returned HTTP ${response.status}`);
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (!isJsonContentType(contentType)) {
        throw new Error('CIMD endpoint must return a JSON media type');
      }
      const decoded: unknown = JSON.parse(new TextDecoder().decode(response.body));
      const metadata = CimdClientMetadataSchema.parse(decoded);
      if (metadata.client_id !== clientId) {
        throw new Error('CIMD client_id does not exactly match the requested URL');
      }
      if (
        !metadata.redirect_uris.every((uri) =>
          isRegistrableRedirectUri(uri, metadata.application_type),
        )
      ) {
        throw new Error(
          'CIMD redirect_uris contains a URI forbidden for the application type',
        );
      }
      const client = toRegisteredClient(metadata);
      if (freshness.store && Number.isFinite(freshness.freshnessMs)) {
        touch(clientId, {
          ok: true,
          client,
          expiresAt: now() + freshness.freshnessMs,
          ...(response.headers.get('etag') !== null && {
            etag: response.headers.get('etag') ?? undefined,
          }),
          ...(response.headers.get('last-modified') !== null && {
            lastModified: response.headers.get('last-modified') ?? undefined,
          }),
        });
      } else {
        dropCache(clientId);
      }
      return client;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'CIMD metadata resolution failed';
      touch(clientId, {
        ok: false,
        message,
        expiresAt: now() + (policy.negativeTtlMs ?? 10_000),
      });
      throw error;
    }
  };

  return async (clientId: string): Promise<RegisteredClient> => {
    const pending = inflight.get(clientId);
    if (pending) return pending;
    const created = resolveOne(clientId).finally(() => inflight.delete(clientId));
    inflight.set(clientId, created);
    return created;
  };
}

function json(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...PUBLIC_CORS, ...extraHeaders },
  });
}

function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status);
}

/**
 * True for a registrable redirect URI. `https` is always allowed; `http` ONLY on
 * a loopback host (RFC 8252 §7.3 — native apps), so a self-registered client
 * cannot receive the authorization code in the clear at an attacker-controlled
 * address.
 *
 * `applicationType` is the OpenID Connect DCR hint (SEP-837): a `web` client is
 * held to https-only (loopback is meaningless for it and a common
 * misconfiguration), a `native` client keeps the loopback allowance. Omitted —
 * the permissive default, so a client that never sends the field behaves
 * exactly as before.
 */
function isRegistrableRedirectUri(value: string, applicationType?: ApplicationType): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === 'https:') return true;
    if (url.protocol !== 'http:') return false;
    if (applicationType === 'web') return false;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return host === '127.0.0.1' || host === '::1' || host === 'localhost';
  } catch {
    return false;
  }
}

function isLoopbackRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:') return false;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return host === '127.0.0.1' || host === '::1' || host === 'localhost';
  } catch {
    return false;
  }
}

/** Append query params to a redirect URI without clobbering its own query. */
function redirectWith(uri: string, params: Record<string, string>): Response {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return new Response(null, { status: 302, headers: { Location: url.toString() } });
}

async function readForm(req: Request): Promise<URLSearchParams> {
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body: unknown = await req.json().catch(() => null);
    const params = new URLSearchParams();
    if (isRecord(body)) {
      // Only string values map cleanly to form params — a nested object would
      // stringify to "[object Object]", so skip non-strings rather than corrupt.
      for (const [key, value] of Object.entries(body)) {
        if (typeof value === 'string') params.set(key, value);
      }
    }
    return params;
  }
  return new URLSearchParams(await req.text());
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * Build the OAuth 2.1 authorization-server routes for an MCP resource. Mount the
 * returned routes in the server's `rawRoutes`, alongside
 * `oauthProtectedResourceRoute` and an MCP handler whose `protectedResource`
 * names this issuer.
 */
export function mountOAuthProvider(config: OAuthProviderConfig): RawRoute[] {
  const base = config.basePath ?? '/oauth';
  const ttl = config.accessTokenTtlSec ?? 3600;
  const registerPath = `${base}/register`;
  const authorizePath = `${base}/authorize`;
  const tokenPath = `${base}/token`;
  const clientRegistration = config.clientRegistration ?? {};
  const dcrRegistry = clientRegistration.dcr || undefined;
  const dcrEnabled = dcrRegistry !== undefined;
  const cimdConfig =
    clientRegistration.cimd === false ? undefined : (clientRegistration.cimd ?? {});
  const cimdEnabled = cimdConfig !== undefined;
  const resolveCimd = cimdEnabled
    ? createCimdResolver({
        cache: cimdConfig.cache,
        fetcher: cimdConfig.fetcher ?? createSecureClientMetadataFetcher(),
        onCacheEvent: cimdConfig.onCacheEvent,
      })
    : undefined;

  const resolveClient = async (clientId: string): Promise<RegisteredClient | null> => {
    const preRegistered = await clientRegistration.preRegistered?.get(clientId);
    if (preRegistered) return preRegistered.clientId === clientId ? preRegistered : null;
    const clientUrl = absoluteClientUrl(clientId);
    if (clientUrl) {
      if (!resolveCimd || clientUrl.protocol !== 'https:') return null;
      try {
        return await resolveCimd(clientId);
      } catch {
        return null;
      }
    }
    const dcrClient = await dcrRegistry?.get(clientId);
    return dcrClient?.clientId === clientId ? dcrClient : null;
  };

  /**
   * Every authorization response — success or error — carries `iss` (RFC 9207,
   * SEP-2468). A client talking to several authorization servers validates it
   * before redeeming the code, which closes the mix-up attack: an attacker's
   * server cannot pass off a response as coming from this issuer. Routed through
   * one helper so no redirect can silently omit it.
   */
  const redirectToClient = (uri: string, params: Record<string, string>): Response =>
    redirectWith(uri, { ...params, iss: config.issuer });

  const metadataRoute: RawRoute = {
    method: 'ALL',
    path: AS_METADATA_PATH,
    handler: (req) => {
      if (req.method === 'OPTIONS')
        return new Response(null, { status: 204, headers: PUBLIC_CORS });
      return json({
        issuer: config.issuer,
        authorization_endpoint: `${config.issuer}${authorizePath}`,
        token_endpoint: `${config.issuer}${tokenPath}`,
        ...(dcrEnabled && { registration_endpoint: `${config.issuer}${registerPath}` }),
        response_types_supported: ['code'],
        grant_types_supported: config.refreshTokens
          ? ['authorization_code', 'refresh_token']
          : ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        ...(cimdEnabled && { client_id_metadata_document_supported: true }),
        // RFC 9207 §3 — tells a client it can (and should) validate `iss` on the
        // authorization response. Without this advertisement a client has no way
        // to know the parameter is authoritative here.
        authorization_response_iss_parameter_supported: true,
        ...(config.scopesSupported && { scopes_supported: config.scopesSupported }),
      });
    },
  };

  const registerRoute: RawRoute = {
    method: 'ALL',
    path: registerPath,
    handler: async (req) => {
      if (req.method === 'OPTIONS')
        return new Response(null, { status: 204, headers: PUBLIC_CORS });
      if (req.method !== 'POST') return oauthError('invalid_request', 'POST required', 405);

      const meta: unknown = await req.json().catch(() => null);
      if (!isRecord(meta)) {
        return oauthError('invalid_client_metadata', 'Body must be a JSON object');
      }
      // SEP-837 — the client declares whether it is a desktop/CLI (`native`) or
      // browser (`web`) app, which decides whether an `http` loopback redirect
      // is registrable. An unknown value is a client mistake, not a default.
      const rawAppType = meta.application_type;
      if (rawAppType !== undefined && rawAppType !== 'native' && rawAppType !== 'web') {
        return oauthError(
          'invalid_client_metadata',
          "application_type must be 'native' or 'web'",
        );
      }
      const applicationType: ApplicationType | undefined = rawAppType;

      const redirectUris = meta.redirect_uris;
      const tokenEndpointAuthMethod = meta.token_endpoint_auth_method ?? 'none';
      if (tokenEndpointAuthMethod !== 'none') {
        return oauthError(
          'invalid_client_metadata',
          'Only public clients with token_endpoint_auth_method "none" are supported',
        );
      }
      if (
        !Array.isArray(redirectUris) ||
        redirectUris.length === 0 ||
        !redirectUris.every(
          (u): u is string =>
            typeof u === 'string' && isRegistrableRedirectUri(u, applicationType),
        )
      ) {
        return oauthError(
          'invalid_redirect_uri',
          applicationType === 'web'
            ? 'redirect_uris must be a non-empty array of absolute https URLs (a web client cannot register an http loopback URI)'
            : 'redirect_uris must be a non-empty array of absolute https URLs (http is allowed only on a loopback host)',
        );
      }

      if (!dcrRegistry) throw new Error('DCR route mounted without a DCR registry');
      const client = await dcrRegistry.register({
        redirectUris: redirectUris,
        clientName: typeof meta.client_name === 'string' ? meta.client_name : undefined,
        tokenEndpointAuthMethod,
        ...(applicationType && { applicationType }),
      });

      return json(
        {
          client_id: client.clientId,
          redirect_uris: client.redirectUris,
          token_endpoint_auth_method: 'none',
          // Only advertise refresh_token when the grant is actually enabled —
          // mirrors grant_types_supported in the AS metadata above; otherwise a
          // client tries a grant /token rejects as unsupported_grant_type.
          grant_types: config.refreshTokens
            ? ['authorization_code', 'refresh_token']
            : ['authorization_code'],
          response_types: ['code'],
          ...(client.clientName && { client_name: client.clientName }),
          ...(client.applicationType && { application_type: client.applicationType }),
        },
        201,
      );
    },
  };

  const authorizeRoute: RawRoute = {
    method: 'ALL',
    path: authorizePath,
    handler: async (req) => {
      if (req.method === 'OPTIONS')
        return new Response(null, { status: 204, headers: PUBLIC_CORS });

      const url = new URL(req.url);
      const p = url.searchParams;
      const clientId = p.get('client_id');
      const redirectUri = p.get('redirect_uri');
      const responseType = p.get('response_type');
      const codeChallenge = p.get('code_challenge');
      const codeChallengeMethod = p.get('code_challenge_method') ?? 'S256';
      const resource = p.get('resource');
      const scope = p.get('scope') ?? undefined;
      const state = p.get('state') ?? undefined;

      if (!clientId || !redirectUri) {
        return oauthError('invalid_request', 'client_id and redirect_uri are required');
      }
      const client = await resolveClient(clientId);
      if (!client) return oauthError('invalid_client', 'Unknown client_id', 401);
      // Exact redirect_uri match — never redirect to an unregistered URI.
      if (!client.redirectUris.includes(redirectUri)) {
        return oauthError('invalid_request', 'redirect_uri does not match a registered URI');
      }
      // From here errors go back to the client via the redirect (OAuth 2.1 §4.1.2.1).
      if (responseType !== 'code') {
        return redirectToClient(redirectUri, {
          error: 'unsupported_response_type',
          ...(state && { state }),
        });
      }
      if (!codeChallenge || codeChallengeMethod !== 'S256') {
        return redirectToClient(redirectUri, {
          error: 'invalid_request',
          error_description: 'PKCE S256 code_challenge is required',
          ...(state && { state }),
        });
      }
      if (!resource) {
        return redirectToClient(redirectUri, {
          error: 'invalid_target',
          error_description: 'resource parameter is required',
          ...(state && { state }),
        });
      }
      // RFC 8707 — reject a resource this server does not serve rather than
      // silently issuing a token for a different audience.
      if (resource !== config.resource) {
        return redirectToClient(redirectUri, {
          error: 'invalid_target',
          error_description: 'resource is not served by this authorization server',
          ...(state && { state }),
        });
      }

      const requestedScopes = parseScopes(scope);
      const supportedScopes = new Set(config.scopesSupported ?? []);
      if (
        config.scopesSupported &&
        requestedScopes.some((requestedScope) => !supportedScopes.has(requestedScope))
      ) {
        return redirectToClient(redirectUri, {
          error: 'invalid_scope',
          error_description: 'One or more requested scopes are not supported',
          ...(state && { state }),
        });
      }
      const requestedScope =
        requestedScopes.length > 0 ? requestedScopes.join(' ') : undefined;

      const authRequest: AuthRequest = {
        clientId,
        redirectUri,
        scope: requestedScope,
        resource,
        state,
        isLoopbackRedirect: isLoopbackRedirectUri(redirectUri),
        ...(safeClientName(client.clientName) !== undefined && {
          clientName: safeClientName(client.clientName),
        }),
        ...(client.applicationType !== undefined && {
          applicationType: client.applicationType,
        }),
        ...(absoluteClientUrl(clientId)?.protocol === 'https:' && {
          clientOrigin: new URL(clientId).origin,
        }),
      };
      const result = await config.authorizeUser(req, authRequest);
      if (result instanceof Response) return result;

      if (
        !Array.isArray(result.approvedScopes) ||
        !result.approvedScopes.every((scope) => typeof scope === 'string')
      ) {
        throw new Error('authorizeUser must return approvedScopes as an array of strings');
      }

      const approvedScopes = [...new Set(result.approvedScopes)];
      if (
        approvedScopes.some(
          (approvedScope) =>
            !requestedScopes.includes(approvedScope) ||
            (config.scopesSupported !== undefined && !supportedScopes.has(approvedScope)),
        )
      ) {
        throw new Error('authorizeUser approvedScopes must be a subset of requested scopes');
      }
      const approvedScope = approvedScopes.length > 0 ? approvedScopes.join(' ') : undefined;

      const code = randomUUID();
      await config.codes.save(code, {
        clientId,
        redirectUri,
        codeChallenge,
        codeChallengeMethod: 'S256',
        resource,
        scope: approvedScope,
        userId: result.userId,
        expiresAt: Date.now() + AUTH_CODE_TTL_MS,
      });

      return redirectToClient(redirectUri, { code, ...(state && { state }) });
    },
  };

  // `audience` is the resource the grant was bound to (validated `=== config.resource`
  // at /authorize) — threading it keeps the token's `aud` driven by the request.
  const issueAccessToken = (
    userId: string,
    audience: string,
    clientId: string,
    scope?: string,
  ): Promise<string> =>
    // `client_id` (RFC 8693 `azp`-style) lets the resource server attribute
    // each call to the OAuth client that the token was issued to.
    signJwt({ scope, client_id: clientId }, config.signingSecret, {
      issuer: config.issuer,
      audience,
      subject: userId,
      expiresInSec: ttl,
    });

  const tokenRoute: RawRoute = {
    method: 'ALL',
    path: tokenPath,
    handler: async (req) => {
      if (req.method === 'OPTIONS')
        return new Response(null, { status: 204, headers: PUBLIC_CORS });
      if (req.method !== 'POST') return oauthError('invalid_request', 'POST required', 405);

      const form = await readForm(req);
      const grantType = form.get('grant_type');

      if (grantType === 'authorization_code') {
        const code = form.get('code');
        const verifier = form.get('code_verifier');
        const redirectUri = form.get('redirect_uri');
        const clientId = form.get('client_id');
        if (!code || !verifier || !redirectUri || !clientId) {
          return oauthError(
            'invalid_request',
            'code, code_verifier, redirect_uri, client_id required',
          );
        }
        const data = await config.codes.take(code);
        if (!data) return oauthError('invalid_grant', 'Unknown or used authorization code');
        if (data.expiresAt < Date.now())
          return oauthError('invalid_grant', 'Authorization code expired');
        if (data.clientId !== clientId)
          return oauthError('invalid_grant', 'client_id mismatch');
        if (data.redirectUri !== redirectUri)
          return oauthError('invalid_grant', 'redirect_uri mismatch');
        if (!(await verifyPkce(verifier, data.codeChallenge))) {
          return oauthError('invalid_grant', 'PKCE verification failed');
        }

        const accessToken = await issueAccessToken(
          data.userId,
          data.resource,
          data.clientId,
          data.scope,
        );
        let refreshToken: string | undefined;
        if (config.refreshTokens) {
          refreshToken = randomUUID();
          await config.refreshTokens.save(refreshToken, {
            clientId: data.clientId,
            resource: data.resource,
            scope: data.scope,
            userId: data.userId,
          });
        }
        return json({
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: ttl,
          ...(data.scope && { scope: data.scope }),
          ...(refreshToken && { refresh_token: refreshToken }),
        });
      }

      if (grantType === 'refresh_token') {
        if (!config.refreshTokens) {
          return oauthError('unsupported_grant_type', 'refresh_token grant is not enabled');
        }
        const token = form.get('refresh_token');
        const clientId = form.get('client_id');
        if (!token || !clientId)
          return oauthError('invalid_request', 'refresh_token and client_id required');
        // Rotate — a refresh token is single-use (OAuth 2.1 §4.3.1 for public clients).
        const data = await config.refreshTokens.take(token);
        if (!data) return oauthError('invalid_grant', 'Unknown or used refresh token');
        if (data.clientId !== clientId)
          return oauthError('invalid_grant', 'client_id mismatch');

        const accessToken = await issueAccessToken(
          data.userId,
          data.resource,
          data.clientId,
          data.scope,
        );
        const newRefresh = randomUUID();
        await config.refreshTokens.save(newRefresh, data);
        return json({
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: ttl,
          ...(data.scope && { scope: data.scope }),
          refresh_token: newRefresh,
        });
      }

      return oauthError(
        'unsupported_grant_type',
        `Unsupported grant_type: ${grantType ?? 'none'}`,
      );
    },
  };

  return dcrEnabled
    ? [metadataRoute, registerRoute, authorizeRoute, tokenRoute]
    : [metadataRoute, authorizeRoute, tokenRoute];
}
