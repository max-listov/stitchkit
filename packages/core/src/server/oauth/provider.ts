import { signJwt } from '../middleware/jwt';
import type { RawRoute } from '../types';
import {
  absoluteClientUrl,
  type CimdCacheEvent,
  type CimdCachePolicy,
  type CimdClientMetadataFetcher,
  createCimdResolver,
  createSecureClientMetadataFetcher,
} from './cimd';
import {
  authorizeRoute,
  metadataRoute,
  type OAuthEndpointContext,
  redirectWith,
  registerRoute,
  tokenRoute,
} from './endpoints';

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

  const ctx: OAuthEndpointContext = {
    config,
    ttl,
    paths: { register: registerPath, authorize: authorizePath, token: tokenPath },
    dcrRegistry,
    cimdEnabled,
    resolveClient,
    redirectToClient,
    issueAccessToken,
  };
  return dcrEnabled
    ? [metadataRoute(ctx), registerRoute(ctx), authorizeRoute(ctx), tokenRoute(ctx)]
    : [metadataRoute(ctx), authorizeRoute(ctx), tokenRoute(ctx)];
}
