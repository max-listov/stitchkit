import type { RuntimeContext } from '../../contract';
import { forbidden, unauthorized } from '../../contract';
import type { MethodDef } from '../types';
import { parseCookies } from './cookies';

export interface JwtPayload {
  [key: string]: unknown;
}

/** Decode a base64url JWT segment to raw bytes (padding-tolerant). */
function decodeBase64Url(segment: string): Uint8Array<ArrayBuffer> {
  const b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

export async function verifyJwt(token: string, secret: string): Promise<JwtPayload> {
  const [headerB64, payloadB64, signatureB64] = token.split('.');
  if (!headerB64 || !payloadB64 || !signatureB64) throw unauthorized('Invalid token format');

  // A malformed segment must be a clean 401, not an uncaught `atob` exception.
  // Header/payload are UTF-8 JSON (decoded via TextDecoder so non-ASCII claims
  // survive); the signature is raw bytes.
  let header: { alg?: unknown };
  let payload: JwtPayload;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    const decoder = new TextDecoder();
    header = JSON.parse(decoder.decode(decodeBase64Url(headerB64)));
    payload = JSON.parse(decoder.decode(decodeBase64Url(payloadB64)));
    signature = decodeBase64Url(signatureB64);
  } catch {
    throw unauthorized('Malformed token');
  }

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

  const now = Date.now() / 1000;
  if (typeof payload.exp === 'number' && payload.exp < now) {
    throw unauthorized('Token expired');
  }
  if (typeof payload.nbf === 'number' && payload.nbf > now) {
    throw unauthorized('Token not yet valid');
  }

  return payload;
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

export type AuthHook = (ctx: RuntimeContext, endpoint: MethodDef) => Promise<void>;

/**
 * Build a `beforeHandle` hook that enforces `endpoint.scope`.
 *
 * Identity resolution and the scope vocabulary stay in the project; the
 * project annotates its `rules` object with `satisfies Record<MyScope, …>` to
 * keep scope coverage exhaustive.
 */
export function createAuthHook<TIdentity>(config: AuthHookConfig<TIdentity>): AuthHook {
  const onAnonymous = config.onAnonymous ?? ((): never => unauthorized());
  const onForbidden = config.onForbidden ?? ((): never => forbidden());

  return async (ctx, endpoint) => {
    if (!(ctx.req instanceof Request)) return;

    const identity = await config.resolve(ctx);
    config.inject?.(ctx, identity);

    const scope = endpoint.scope ?? config.defaultScope;
    if (!scope) return;

    const rule = config.rules[scope];
    if (!rule || rule === 'public') return;

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
