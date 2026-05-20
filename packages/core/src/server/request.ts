/**
 * HTTP request helpers — header parsing, client identification, trace ids.
 * Pure `Request → value` functions; no framework state.
 */

import { isUnsafeKey } from '../internal/safe-json';
import { isRecord } from '../internal/typed';

/** Compact, time-sortable id — base36 timestamp + a cryptographic suffix. */
export function generateTraceId(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Trace id for a request: a trusted inbound `x-request-id` / `x-trace-id`
 * header (set by the edge proxy) when present and sane, else a fresh one.
 * Shared by the router, the logger and any consumer that wants the same id.
 */
export function resolveTraceId(req: Request): string {
  const header = req.headers.get('x-request-id') ?? req.headers.get('x-trace-id');
  const trimmed = header?.trim();
  // Accept only a sane id — anything with CRLF or odd chars is rejected before
  // it is echoed into a response header or a log line (injection guard).
  if (trimmed && trimmed.length <= 128 && /^[\w.-]+$/.test(trimmed)) {
    return trimmed;
  }
  return generateTraceId();
}

/**
 * Resolve the real socket peer IP from the runtime — unspoofable, unlike a
 * header. On Bun the server resolves it (`server.requestIP`); on Node / Deno
 * the `srvx` adapter attaches `.ip` to the request. `undefined` when neither
 * is available (the bare `createHandler` fetch with no server).
 */
export function resolveSocketIp(req: Request, server: unknown): string | undefined {
  if (
    typeof server === 'object' &&
    server !== null &&
    'requestIP' in server &&
    typeof server.requestIP === 'function'
  ) {
    const addr: unknown = server.requestIP(req);
    if (isRecord(addr) && typeof addr.address === 'string' && addr.address) {
      return addr.address;
    }
  }
  // `srvx` (Node / Deno) attaches the client IP to the request object.
  if ('ip' in req && typeof req.ip === 'string' && req.ip) return req.ip;
  return undefined;
}

/** Options for `extractIp` / `getClientInfo`. */
export interface ClientIpOptions {
  /**
   * Trust `x-forwarded-for` / `x-real-ip` for the client IP. Enable only behind
   * a proxy that overwrites them — they are client-controllable. Default
   * `false`: the real socket IP (`socketIp`) is used instead.
   */
  trustProxy?: boolean;
  /** The real socket peer IP — see `resolveSocketIp`. */
  socketIp?: string;
}

/**
 * The client IP for a request. With `trustProxy`, the `x-forwarded-for` /
 * `x-real-ip` client wins (the server sits behind a proxy that rewrites them);
 * otherwise the real, unspoofable socket peer (`socketIp`) is used. Returns
 * `''` when nothing is known.
 */
export function extractIp(req: Request, options: ClientIpOptions = {}): string {
  if (options.trustProxy) {
    const forwarded = req.headers.get('x-forwarded-for');
    if (forwarded) return (forwarded.split(',')[0] ?? '').trim().replace(/^::ffff:/, '');
    const realIp = req.headers.get('x-real-ip');
    if (realIp) return realIp.trim().replace(/^::ffff:/, '');
  }
  return (options.socketIp ?? '').replace(/^::ffff:/, '');
}

/** Client identity — IP + user-agent. The one place projects derive both. */
export function getClientInfo(
  req: Request,
  options: ClientIpOptions = {},
): {
  ipAddress?: string;
  userAgent?: string;
} {
  return {
    ipAddress: extractIp(req, options) || undefined,
    userAgent: req.headers.get('user-agent') ?? undefined,
  };
}

/** Flatten a URL query string — repeated keys collapse to arrays. */
export function parseQueryParams(url: URL): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    // `?__proto__=x` would pollute the prototype chain on assignment.
    if (isUnsafeKey(key)) continue;
    const values = url.searchParams.getAll(key);
    const [first] = values;
    query[key] = values.length === 1 && first !== undefined ? first : values;
  }
  return query;
}
