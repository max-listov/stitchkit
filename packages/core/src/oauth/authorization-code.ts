/**
 * Browser-safe OAuth Authorization Code + PKCE mechanics.
 *
 * The application owns navigation, token exchange, identity, persistence,
 * sessions, roles and account policy. This module owns one pending browser
 * transaction and consumes it exactly once.
 */
import type { z } from 'zod';
import { bytesToBase64Url } from '../internal/base64url';
import { deriveCodeChallenge } from '../internal/pkce';

const TRANSACTION_VERSION = 1;
const RESERVED_PARAMETERS = new Set([
  'response_type',
  'client_id',
  'redirect_uri',
  'scope',
  'state',
  'nonce',
  'code_challenge',
  'code_challenge_method',
]);

export type AuthorizationCodeClientErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'RESERVED_PARAMETER'
  | 'INVALID_CONTEXT'
  | 'STORAGE_FAILURE'
  | 'MISSING_TRANSACTION'
  | 'MALFORMED_TRANSACTION'
  | 'UNSUPPORTED_TRANSACTION_VERSION'
  | 'STATE_MISMATCH';

const ERROR_MESSAGES: Record<AuthorizationCodeClientErrorCode, string> = {
  INVALID_CONFIGURATION: 'The OAuth client configuration is invalid.',
  RESERVED_PARAMETER: 'A provider parameter conflicts with the OAuth protocol.',
  INVALID_CONTEXT: 'The OAuth transaction context is invalid.',
  STORAGE_FAILURE: 'The OAuth transaction store is unavailable.',
  MISSING_TRANSACTION: 'The OAuth transaction is missing or was already consumed.',
  MALFORMED_TRANSACTION: 'The OAuth transaction is malformed.',
  UNSUPPORTED_TRANSACTION_VERSION: 'The OAuth transaction version is unsupported.',
  STATE_MISMATCH: 'The OAuth response state does not match the pending transaction.',
};

export class AuthorizationCodeClientError extends Error {
  readonly code: AuthorizationCodeClientErrorCode;

  constructor(code: AuthorizationCodeClientErrorCode, options?: ErrorOptions) {
    super(ERROR_MESSAGES[code], options);
    this.name = 'AuthorizationCodeClientError';
    this.code = code;
  }
}

export interface AuthorizationCodeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface AuthorizationCodeCrypto {
  getRandomValues(bytes: Uint8Array): Uint8Array;
  subtle: Pick<SubtleCrypto, 'digest'>;
}

export interface AuthorizationCodeClientConfig<TContext> {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  storage: AuthorizationCodeStorage;
  storageKey: string;
  contextSchema: z.ZodType<TContext>;
  authorizationParameters?: Readonly<Record<string, string>>;
  /** Web Crypto seam for deterministic tests. Defaults at call time, never module load. */
  crypto?: AuthorizationCodeCrypto;
}

export interface BeginAuthorizationCodeInput<TContext> {
  context: TContext;
}

export interface BeginAuthorizationCodeResult {
  authorizationUrl: string;
}

export interface ConsumeAuthorizationCodeInput {
  state: string;
}

export interface ConsumedAuthorizationCode<TContext> {
  codeVerifier: string;
  nonce: string;
  redirectUri: string;
  context: TContext;
}

export interface AuthorizationCodeClient<TContext> {
  begin(input: BeginAuthorizationCodeInput<TContext>): Promise<BeginAuthorizationCodeResult>;
  consume(input: ConsumeAuthorizationCodeInput): ConsumedAuthorizationCode<TContext>;
}

interface PendingTransaction<TContext> {
  version: typeof TRANSACTION_VERSION;
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  context: TContext;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function randomToken(crypto: AuthorizationCodeCrypto): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function runtimeCrypto(): AuthorizationCodeCrypto {
  const runtime = globalThis.crypto;
  if (!runtime?.subtle || typeof runtime.getRandomValues !== 'function') {
    throw new AuthorizationCodeClientError('INVALID_CONFIGURATION');
  }
  return {
    getRandomValues: (bytes) => runtime.getRandomValues(bytes),
    subtle: runtime.subtle,
  };
}

function parseTransaction<TContext>(
  raw: string,
  contextSchema: z.ZodType<TContext>,
): PendingTransaction<TContext> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new AuthorizationCodeClientError('MALFORMED_TRANSACTION');
  }
  const record = recordOf(decoded);
  if (!record) throw new AuthorizationCodeClientError('MALFORMED_TRANSACTION');
  if (record.version !== TRANSACTION_VERSION) {
    throw new AuthorizationCodeClientError('UNSUPPORTED_TRANSACTION_VERSION');
  }
  const context = contextSchema.safeParse(record.context);
  if (!context.success) throw new AuthorizationCodeClientError('INVALID_CONTEXT');
  if (
    typeof record.state !== 'string' ||
    typeof record.nonce !== 'string' ||
    typeof record.codeVerifier !== 'string' ||
    typeof record.redirectUri !== 'string'
  ) {
    throw new AuthorizationCodeClientError('MALFORMED_TRANSACTION');
  }
  return {
    version: TRANSACTION_VERSION,
    state: record.state,
    nonce: record.nonce,
    codeVerifier: record.codeVerifier,
    redirectUri: record.redirectUri,
    context: context.data,
  };
}

export function createAuthorizationCodeClient<TContext>(
  config: AuthorizationCodeClientConfig<TContext>,
): AuthorizationCodeClient<TContext> {
  if (
    !config.authorizationEndpoint ||
    !config.clientId ||
    !config.redirectUri ||
    !config.storageKey ||
    config.scopes.length === 0 ||
    config.scopes.some((scope) => !scope)
  ) {
    throw new AuthorizationCodeClientError('INVALID_CONFIGURATION');
  }
  for (const parameter of Object.keys(config.authorizationParameters ?? {})) {
    if (RESERVED_PARAMETERS.has(parameter)) {
      throw new AuthorizationCodeClientError('RESERVED_PARAMETER');
    }
  }

  return {
    async begin({ context }) {
      const parsedContext = config.contextSchema.safeParse(context);
      if (!parsedContext.success) throw new AuthorizationCodeClientError('INVALID_CONTEXT');
      const crypto = config.crypto ?? runtimeCrypto();
      const state = randomToken(crypto);
      const nonce = randomToken(crypto);
      const codeVerifier = randomToken(crypto);
      const codeChallenge = await deriveCodeChallenge(codeVerifier, crypto.subtle);
      let url: URL;
      try {
        url = new URL(config.authorizationEndpoint);
      } catch {
        throw new AuthorizationCodeClientError('INVALID_CONFIGURATION');
      }
      for (const [name, value] of Object.entries(config.authorizationParameters ?? {})) {
        url.searchParams.set(name, value);
      }
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('redirect_uri', config.redirectUri);
      url.searchParams.set('scope', config.scopes.join(' '));
      url.searchParams.set('state', state);
      url.searchParams.set('nonce', nonce);
      url.searchParams.set('code_challenge', codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');

      const transaction: PendingTransaction<TContext> = {
        version: TRANSACTION_VERSION,
        state,
        nonce,
        codeVerifier,
        redirectUri: config.redirectUri,
        context: parsedContext.data,
      };
      try {
        config.storage.setItem(config.storageKey, JSON.stringify(transaction));
      } catch {
        throw new AuthorizationCodeClientError('STORAGE_FAILURE');
      }
      return { authorizationUrl: url.toString() };
    },

    consume({ state }) {
      let raw: string | null;
      try {
        raw = config.storage.getItem(config.storageKey);
        config.storage.removeItem(config.storageKey);
      } catch {
        throw new AuthorizationCodeClientError('STORAGE_FAILURE');
      }
      if (raw === null) throw new AuthorizationCodeClientError('MISSING_TRANSACTION');
      const transaction = parseTransaction(raw, config.contextSchema);
      if (transaction.state !== state)
        throw new AuthorizationCodeClientError('STATE_MISMATCH');
      return {
        codeVerifier: transaction.codeVerifier,
        nonce: transaction.nonce,
        redirectUri: transaction.redirectUri,
        context: transaction.context,
      };
    },
  };
}

/** Keep a return target on the current origin, or use the caller's trusted fallback. */
export function safeInternalReturnPath(
  candidate: string | null | undefined,
  fallback: string,
): string {
  const hasAsciiControl = [...(candidate ?? '')].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  if (
    !candidate?.startsWith('/') ||
    candidate.startsWith('//') ||
    candidate.includes('\\') ||
    hasAsciiControl
  ) {
    return fallback;
  }
  return candidate;
}
