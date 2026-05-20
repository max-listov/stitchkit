import { isUnsafeKey } from '../../internal/safe-json';

export function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  const cookies: Record<string, string> = {};
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    // A segment with no `=` is not a cookie — skip it rather than store `''`.
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim();
    // A cookie named `__proto__` would pollute the prototype chain.
    if (!key || isUnsafeKey(key)) continue;
    const raw = pair.slice(eq + 1).trim();
    try {
      cookies[key] = decodeURIComponent(raw);
    } catch {
      cookies[key] = raw;
    }
  }
  return cookies;
}

export interface CookieOptions {
  maxAge?: number;
  path?: string;
  domain?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export function serializeCookie(
  name: string,
  value: string,
  opts: CookieOptions = {},
): string {
  let cookie = `${name}=${encodeURIComponent(value)}`;
  if (opts.maxAge !== undefined) cookie += `; Max-Age=${opts.maxAge}`;
  if (opts.path) cookie += `; Path=${opts.path}`;
  if (opts.domain) cookie += `; Domain=${opts.domain}`;
  if (opts.secure) cookie += '; Secure';
  if (opts.httpOnly) cookie += '; HttpOnly';
  if (opts.sameSite) cookie += `; SameSite=${opts.sameSite}`;
  return cookie;
}

/** A cookie's name + options bundled into a typed read/set/clear handle. */
export interface CookieDef {
  /** Read this cookie's value from a request (`undefined` if absent). */
  get(req: Request): string | undefined;
  /** Build a `Set-Cookie` header value for `value` with the baked-in options. */
  set(value: string): string;
  /** Build a `Set-Cookie` header value that clears the cookie. */
  clear(): string;
}

/**
 * Bundle a cookie's name + options into a typed handle — define it once,
 * then `get` / `set` / `clear` without repeating the config at every call site.
 *
 * ```ts
 * const session = defineCookie({ name: 'sid', httpOnly: true, path: '/' });
 * session.get(req);        // string | undefined
 * session.set('abc123');   // → Set-Cookie value
 * session.clear();         // → Set-Cookie value (Max-Age=0)
 * ```
 */
export function defineCookie(config: CookieOptions & { name: string }): CookieDef {
  const { name, ...options } = config;
  return {
    get(req) {
      return parseCookies(req.headers.get('cookie'))[name];
    },
    set(value) {
      return serializeCookie(name, value, options);
    },
    clear() {
      return serializeCookie(name, '', { ...options, maxAge: 0 });
    },
  };
}
