/**
 * Google OIDC credential verification for a server callback.
 *
 * This leaf returns a verified provider identity only. Database persistence,
 * user lookup/merge, sessions, roles, navigation and UI remain application policy.
 */
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';

const DEFAULT_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const DEFAULT_TIMEOUT_MS = 10_000;

export type GoogleOidcErrorCode =
  | 'MISCONFIGURED'
  | 'INVALID_CREDENTIAL'
  | 'UPSTREAM_UNAVAILABLE';

const ERROR_MESSAGES: Record<GoogleOidcErrorCode, string> = {
  MISCONFIGURED: 'Google OIDC is not configured correctly.',
  INVALID_CREDENTIAL: 'The Google credential is invalid.',
  UPSTREAM_UNAVAILABLE: 'Google identity verification is temporarily unavailable.',
};

export class GoogleOidcError extends Error {
  readonly code: GoogleOidcErrorCode;
  readonly retryable: boolean;

  constructor(code: GoogleOidcErrorCode, options?: ErrorOptions) {
    super(ERROR_MESSAGES[code], options);
    this.name = 'GoogleOidcError';
    this.code = code;
    this.retryable = code === 'UPSTREAM_UNAVAILABLE';
  }
}

export interface GoogleOidcIdentity {
  subject: string;
  email: string;
  name?: string;
  picture?: string;
}

export interface GoogleOidcClaims {
  sub?: string;
  email?: string;
  emailVerified?: boolean;
  nonce?: string;
  name?: string;
  picture?: string;
}

export interface GoogleOidcExchangeInput {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  tokenEndpoint: string;
  signal: AbortSignal;
}

export type GoogleOidcTokenTransport = (
  input: GoogleOidcExchangeInput,
) => Promise<{ idToken: string }>;

export type GoogleOidcIdTokenVerifier = (input: {
  idToken: string;
  audience: string;
}) => Promise<GoogleOidcClaims>;

export interface GoogleOidcClientConfig {
  clientId: string;
  clientSecret: string;
  allowedRedirectUris: readonly string[];
  timeoutMs?: number;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  tokenTransport?: GoogleOidcTokenTransport;
  idTokenVerifier?: GoogleOidcIdTokenVerifier;
}

export interface ExchangeGoogleAuthorizationCodeInput {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  nonce: string;
}

export interface GoogleOidcClient {
  exchangeAuthorizationCode(
    input: ExchangeGoogleAuthorizationCodeInput,
  ): Promise<GoogleOidcIdentity>;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function statusOf(error: unknown): number | null {
  const record = recordOf(error);
  const response = recordOf(record?.response);
  return typeof response?.status === 'number' ? response.status : null;
}

function codeOf(error: unknown): string | null {
  const record = recordOf(error);
  return typeof record?.code === 'string' ? record.code : null;
}

function upstreamVerifierFailure(error: unknown): boolean {
  const status = statusOf(error);
  if (status !== null && (status === 429 || status >= 500)) return true;
  return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(
    codeOf(error) ?? '',
  );
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.length !== rightBytes.length) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function defaultTokenTransport(
  fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): GoogleOidcTokenTransport {
  return async (input) => {
    let response: Response;
    try {
      response = await fetcher(input.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: input.code,
          code_verifier: input.codeVerifier,
          redirect_uri: input.redirectUri,
          client_id: input.clientId,
          client_secret: input.clientSecret,
        }),
        signal: input.signal,
      });
    } catch {
      throw new GoogleOidcError('UPSTREAM_UNAVAILABLE');
    }
    if (!response.ok) {
      throw new GoogleOidcError(
        response.status === 429 || response.status >= 500
          ? 'UPSTREAM_UNAVAILABLE'
          : 'INVALID_CREDENTIAL',
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new GoogleOidcError('UPSTREAM_UNAVAILABLE');
    }
    const idToken = recordOf(body)?.id_token;
    if (typeof idToken !== 'string' || !idToken) {
      throw new GoogleOidcError('INVALID_CREDENTIAL');
    }
    return { idToken };
  };
}

function defaultIdTokenVerifier(
  clientId: string,
  clientSecret: string,
): GoogleOidcIdTokenVerifier {
  const client = new OAuth2Client(clientId, clientSecret);
  return async ({ idToken, audience }) => {
    const ticket = await client.verifyIdToken({ idToken, audience });
    const payload = ticket.getPayload();
    if (!payload) throw new GoogleOidcError('INVALID_CREDENTIAL');
    return {
      sub: payload.sub,
      email: payload.email,
      emailVerified: payload.email_verified,
      nonce: payload.nonce,
      name: payload.name,
      picture: payload.picture,
    };
  };
}

export function createGoogleOidcClient(config: GoogleOidcClientConfig): GoogleOidcClient {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    !config.clientId ||
    !config.clientSecret ||
    config.allowedRedirectUris.length === 0 ||
    config.allowedRedirectUris.some((uri) => !uri) ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new GoogleOidcError('MISCONFIGURED');
  }
  const allowedRedirectUris = new Set(config.allowedRedirectUris);
  const transport =
    config.tokenTransport ?? defaultTokenTransport(config.fetch ?? globalThis.fetch);
  const verify =
    config.idTokenVerifier ?? defaultIdTokenVerifier(config.clientId, config.clientSecret);

  return {
    async exchangeAuthorizationCode(input) {
      if (!allowedRedirectUris.has(input.redirectUri)) {
        throw new GoogleOidcError('INVALID_CREDENTIAL');
      }
      if (!input.code || !input.codeVerifier || !input.nonce) {
        throw new GoogleOidcError('INVALID_CREDENTIAL');
      }
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new GoogleOidcError('UPSTREAM_UNAVAILABLE'));
        }, timeoutMs);
      });
      let exchanged: { idToken: string };
      try {
        exchanged = await Promise.race([
          transport({
            code: input.code,
            codeVerifier: input.codeVerifier,
            redirectUri: input.redirectUri,
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            tokenEndpoint: DEFAULT_TOKEN_ENDPOINT,
            signal: controller.signal,
          }),
          deadline,
        ]);
      } catch (cause) {
        if (cause instanceof GoogleOidcError) throw cause;
        throw new GoogleOidcError('UPSTREAM_UNAVAILABLE');
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (!exchanged.idToken) throw new GoogleOidcError('INVALID_CREDENTIAL');

      let claims: GoogleOidcClaims;
      try {
        claims = await verify({ idToken: exchanged.idToken, audience: config.clientId });
      } catch (cause) {
        if (cause instanceof GoogleOidcError) throw cause;
        throw new GoogleOidcError(
          upstreamVerifierFailure(cause) ? 'UPSTREAM_UNAVAILABLE' : 'INVALID_CREDENTIAL',
        );
      }
      if (
        !claims.sub ||
        !claims.email ||
        claims.emailVerified !== true ||
        !claims.nonce ||
        !constantTimeEqual(claims.nonce, input.nonce) ||
        !z.email().safeParse(claims.email).success
      ) {
        throw new GoogleOidcError('INVALID_CREDENTIAL');
      }
      return {
        subject: claims.sub,
        email: claims.email,
        ...(claims.name ? { name: claims.name } : {}),
        ...(claims.picture ? { picture: claims.picture } : {}),
      };
    },
  };
}
