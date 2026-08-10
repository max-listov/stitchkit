import type { RuntimeContext } from '../../contract';
import { forbidden, unauthorized } from '../../contract';
import { base64UrlToBytes, bytesToBase64Url } from '../../internal/base64url';
import { safeJsonParse } from '../../internal/safe-json';
import { isRecord } from '../../internal/typed';
import type { OperationIdentity } from '../types';
import { parseCookies } from './cookies';

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

export function extractToken(req: Request, cookieName?: string): string | null {
  const authHeader = req.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);

  if (cookieName) {
    const cookies = parseCookies(req.headers.get('cookie'));
    return cookies[cookieName] ?? null;
  }

  return null;
}

// ─── Scope-aware authentication ──────────────────────
//
// Every project repeats the same three steps on each request: resolve the
// caller identity (cookie / bearer + DB lookup), read the endpoint scope, then
// allow / 401 / 403. The identity model and the scope set differ per project,
// the control flow does not — so the flow lives here and the project supplies
// only `resolve` and a declarative `rules` map.

/**
 * Per-scope access predicate. `endpoint.scope` selects which rule applies:
 *  - `'public'`        — always pass (identity attached if present).
 *  - `'authenticated'` — any resolved identity passes.
 *  - function          — custom check; gets the identity and the full context
 *    (so it can read `ctx.pathParams` for resource-scoped access). May be
 *    async — resource-scoped checks usually need a DB lookup.
 */
export type AuthRule<TIdentity> =
  | 'public'
  | 'authenticated'
  | ((identity: Awaited<TIdentity>, ctx: RuntimeContext) => boolean | Promise<boolean>);

export interface AuthHookConfig<TIdentity> {
  /** Resolve the request identity — cookie / bearer + DB lookup. */
  resolve: (ctx: RuntimeContext) => Promise<TIdentity | null>;
  /**
   * Resolve identity on a non-HTTP context (a tool call) where there is no
   * `req`. The transport (MCP / agent) has already authenticated the caller;
   * this locates the identity it injected into `ctx` (via `buildMcpServer`'s
   * `context`). Without it, a scoped tool call with no `req` **fails closed**
   * — the scope rule sees no identity and `onAnonymous` rejects the call.
   */
  resolveFromContext?: (ctx: RuntimeContext) => TIdentity | null | Promise<TIdentity | null>;
  /** Access rule per scope; `endpoint.scope` is the key. */
  rules: Record<string, AuthRule<TIdentity>>;
  /** Scope applied when an endpoint declares none. */
  defaultScope?: string;
  /** Write the resolved identity onto the context for handlers. */
  inject?: (ctx: RuntimeContext, identity: Awaited<TIdentity> | null) => void;
  /** Thrown when the scope needs an identity and there is none. */
  onAnonymous?: () => never;
  /** Thrown when an identity is present but the rule rejects it. */
  onForbidden?: () => never;
}

export type AuthHook = (ctx: RuntimeContext, endpoint: OperationIdentity) => Promise<void>;

/**
 * Build a `beforeHandle` hook that enforces `endpoint.scope`.
 *
 * Identity resolution and the scope vocabulary stay in the project; the
 * project annotates its `rules` object with `satisfies Record<MyScope, …>` to
 * keep scope coverage exhaustive.
 *
 * The hook runs on both surfaces: as `createServer`'s `beforeHandle` (HTTP) and
 * as a tool mount's `lifecycle.beforeHandle` (MCP / agent). On HTTP it resolves
 * identity from `ctx.req` via `resolve`; on a tool call — where there is no
 * `req` — it uses `resolveFromContext`. If `resolveFromContext` is omitted, a
 * scoped tool call has no identity and **fails closed** (never silently passes).
 */
export function createAuthHook<TIdentity>(config: AuthHookConfig<TIdentity>): AuthHook {
  const onAnonymous = config.onAnonymous ?? ((): never => unauthorized());
  const onForbidden = config.onForbidden ?? ((): never => forbidden());

  return async (ctx, endpoint) => {
    // The transport tag is authoritative — `ctx.source` is `'http'` only on a
    // real HTTP request. HTTP resolves identity from `ctx.req`; a tool call has
    // none, so it uses `resolveFromContext`. Never skip the scope check.
    const identity =
      ctx.source === 'http'
        ? await config.resolve(ctx)
        : ((await config.resolveFromContext?.(ctx)) ?? null);
    config.inject?.(ctx, identity);

    const scope = endpoint.scope ?? config.defaultScope;
    if (!scope) return;

    const rule = Object.hasOwn(config.rules, scope) ? config.rules[scope] : undefined;
    // An endpoint that declares a scope with no matching rule is a config
    // mistake — fail closed, never silently pass an unguarded endpoint.
    if (!rule) {
      throw new Error(`[stitchkit] auth: no rule for scope "${scope}"`);
    }
    if (rule === 'public') return;

    if (!identity) {
      onAnonymous();
      return;
    }
    if (rule === 'authenticated') return;
    if (!(await rule(identity, ctx))) onForbidden();
  };
}

// ─── Bearer-token resolver ───────────────────────────

/**
 * Bearer-token identity resolver — the MCP / API-key counterpart of the
 * cookie session hook. Strips `Authorization: Bearer <token>` and hands the
 * raw token (plus the request, for IP / user-agent) to the project lookup.
 */
export interface BearerResolverConfig<TIdentity> {
  /** Resolve a raw token to identity. Return `null` for unknown / revoked. */
  lookup: (token: string, req: Request) => Promise<TIdentity | null>;
}

export function createBearerResolver<TIdentity>(
  config: BearerResolverConfig<TIdentity>,
): (req: Request) => Promise<TIdentity | null> {
  return async (req: Request) => {
    const token = extractToken(req);
    if (!token) return null;
    return config.lookup(token, req);
  };
}
