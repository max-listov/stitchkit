/**
 * Client ID Metadata Documents: a `client_id` that is an https URL names a
 * document the client publishes, fetched over a pinned, bounded connection and
 * cached with its HTTP freshness — positive and negative entries in separate,
 * bounded pools, resolutions rate-limited per client and overall.
 */
import { z } from 'zod';
import { fetchPinnedDocument } from '../../internal/secure-fetch';
import type { ApplicationType, RegisteredClient } from './provider';

export function isPlainDisplayCharacter(character: string): boolean {
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

export const DEFAULT_CIMD_MAX_BYTES = 64 * 1024;
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

export function absoluteClientUrl(clientId: string): URL | null {
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

export function createCimdResolver(options: {
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

export function isRegistrableRedirectUri(
  value: string,
  applicationType?: ApplicationType,
): boolean {
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

export function isLoopbackRedirectUri(value: string): boolean {
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
