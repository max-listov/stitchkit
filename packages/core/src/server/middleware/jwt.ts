import { unauthorized } from '../../contract/errors';
import { base64UrlToBytes, bytesToBase64Url } from '../../internal/base64url';
import { safeJsonParse } from '../../internal/safe-json';
import { isRecord } from '../../internal/typed';

export interface JwtPayload {
  [key: string]: unknown;
}

/** Tuning for `verifyJwt`. */
export interface VerifyJwtOptions {
  /** Clock-skew tolerance for `exp` / `nbf`, in seconds. Default `60`. */
  leewaySeconds?: number;
  /** Required `iss` claim — the token is rejected on mismatch. */
  issuer?: string;
  /** Required `aud` claim — the token is rejected if it does not carry it. */
  audience?: string;
}

/** A JWT longer than this is rejected before any decoding work. */
const MAX_TOKEN_BYTES = 8192;

export async function verifyJwt(
  token: string,
  secret: string,
  options: VerifyJwtOptions = {},
): Promise<JwtPayload> {
  // An empty secret yields a trivially forgeable HMAC — fail loud, not silent.
  if (!secret) throw new Error('verifyJwt: a non-empty secret is required');
  if (token.length > MAX_TOKEN_BYTES) throw unauthorized('Token too large');

  const [headerB64, payloadB64, signatureB64] = token.split('.');
  if (!headerB64 || !payloadB64 || !signatureB64) throw unauthorized('Invalid token format');

  // A malformed segment must be a clean 401, not an uncaught `atob` exception.
  // Header/payload are UTF-8 JSON (decoded via TextDecoder so non-ASCII claims
  // survive); the signature is raw bytes.
  let header: { alg?: unknown };
  let payloadRaw: unknown;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    const decoder = new TextDecoder();
    header = JSON.parse(decoder.decode(base64UrlToBytes(headerB64)));
    // `safeJsonParse` drops `__proto__` — a claim cannot pollute the prototype.
    payloadRaw = safeJsonParse(decoder.decode(base64UrlToBytes(payloadB64)));
    signature = base64UrlToBytes(signatureB64);
  } catch {
    throw unauthorized('Malformed token');
  }
  if (!isRecord(payloadRaw)) throw unauthorized('Malformed token');
  const payload: JwtPayload = payloadRaw;

  // Pin the algorithm — never let the token's own `alg` pick the scheme.
  if (header.alg !== 'HS256') throw unauthorized('Unsupported token algorithm');

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  const data = encoder.encode(`${headerB64}.${payloadB64}`);
  const valid = await crypto.subtle.verify('HMAC', key, signature, data);
  if (!valid) throw unauthorized('Invalid token signature');

  const leeway = options.leewaySeconds ?? 60;
  const now = Date.now() / 1000;
  // A present-but-non-numeric `exp` / `nbf` is malformed — never treat it as
  // "absent" (that would make the token effectively non-expiring).
  if ('exp' in payload) {
    if (typeof payload.exp !== 'number') throw unauthorized('Malformed token');
    if (payload.exp < now - leeway) throw unauthorized('Token expired');
  }
  if ('nbf' in payload) {
    if (typeof payload.nbf !== 'number') throw unauthorized('Malformed token');
    if (payload.nbf > now + leeway) throw unauthorized('Token not yet valid');
  }
  if (options.issuer !== undefined && payload.iss !== options.issuer) {
    throw unauthorized('Token issuer mismatch');
  }
  if (options.audience !== undefined) {
    const aud = payload.aud;
    const ok = Array.isArray(aud) ? aud.includes(options.audience) : aud === options.audience;
    if (!ok) throw unauthorized('Token audience mismatch');
  }

  return payload;
}

/** Tuning for `signJwt`. */
export interface SignJwtOptions {
  /** Lifetime in seconds — sets `exp` to now + this. Omit for no expiry. */
  expiresInSec?: number;
  /** `iss` claim. */
  issuer?: string;
  /** `aud` claim. */
  audience?: string;
  /** `sub` claim. */
  subject?: string;
}

/**
 * Sign a payload as an HS256 JWT — the issuing counterpart of `verifyJwt`.
 * Used to mint OAuth access tokens whose audience binds them to one resource.
 * `iat` is always set; `exp` / `iss` / `aud` / `sub` follow `options`.
 */
export async function signJwt(
  payload: JwtPayload,
  secret: string,
  options: SignJwtOptions = {},
): Promise<string> {
  if (!secret) throw new Error('signJwt: a non-empty secret is required');

  const now = Math.floor(Date.now() / 1000);
  const claims: JwtPayload = {
    ...payload,
    iat: now,
    ...(options.expiresInSec !== undefined && { exp: now + options.expiresInSec }),
    ...(options.issuer !== undefined && { iss: options.issuer }),
    ...(options.audience !== undefined && { aud: options.audience }),
    ...(options.subject !== undefined && { sub: options.subject }),
  };

  const encoder = new TextEncoder();
  const headerB64 = bytesToBase64Url(
    encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
  );
  const payloadB64 = bytesToBase64Url(encoder.encode(JSON.stringify(claims)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput));
  const signatureB64 = bytesToBase64Url(new Uint8Array(signature));

  return `${signingInput}.${signatureB64}`;
}
