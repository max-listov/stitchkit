import { isUnsafeKey } from '../../internal/safe-json';

/**
 * Every `name=value` pair of a `Cookie` header, in header order, duplicates
 * kept. The order is the browser's (RFC 6265 §5.4: longer path first, then
 * earlier creation time) and a server "SHOULD NOT rely upon" it (§4.2.2) — so
 * this list is what a reader consults when it needs to see *all* candidates
 * rather than the one the order happened to put last.
 */
export function parseCookieHeader(header: string | null): Array<[string, string]> {
  if (!header) return [];
  const pairs: Array<[string, string]> = [];
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    // A segment with no `=` is not a cookie — skip it rather than store `''`.
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim();
    if (!key) continue;
    const raw = pair.slice(eq + 1).trim();
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      // Not percent-encoded — the raw text is the value.
    }
    pairs.push([key, value]);
  }
  return pairs;
}

/**
 * The `Cookie` header as a record. Two cookies with one name collapse to the
 * **last** occurrence — a fact of the record shape, not a rule about cookies;
 * `parseCookieHeader` keeps both, and `defineCookie` lets a handle declare
 * which it wants.
 */
export function parseCookies(header: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const [key, value] of parseCookieHeader(header)) {
    // A cookie named `__proto__` would pollute the prototype chain.
    if (isUnsafeKey(key)) continue;
    cookies[key] = value;
  }
  return cookies;
}

/**
 * What `get` answers when the request carries more than one cookie of this
 * name. The browser decides their order, so `'last'` and `'first'` are each a
 * coin the browser flips; they exist so an application can *name* the
 * behaviour it relies on. `'reject'` refuses to flip it: two **different**
 * values yield `undefined`, so a session reader sees "no session" instead of
 * a session that works in one browser and not another. Two identical values
 * are one value — a host cookie and a parent-domain cookie set by the same
 * application — and are returned.
 */
export type CookieDuplicatesPolicy = 'last' | 'first' | 'reject';

export interface CookieOptions {
  maxAge?: number;
  path?: string;
  domain?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  /** How `get` resolves two cookies of this name; default `'last'`. */
  duplicates?: CookieDuplicatesPolicy;
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
  /**
   * Read this cookie's value from a request (`undefined` if absent). With two
   * cookies of this name the answer follows the handle's `duplicates` policy.
   */
  get(req: Request): string | undefined;
  /** Every value of this name the request carries, in header order. */
  getAll(req: Request): string[];
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
  const { name, duplicates = 'last', ...options } = config;
  const getAll = (req: Request): string[] =>
    parseCookieHeader(req.headers.get('cookie')).flatMap(([key, value]) =>
      key === name ? [value] : [],
    );
  return {
    get(req) {
      const values = getAll(req);
      if (values.length === 0) return undefined;
      if (duplicates === 'first') return values[0];
      if (duplicates === 'reject') {
        return new Set(values).size === 1 ? values[0] : undefined;
      }
      return values[values.length - 1];
    },
    getAll,
    set(value) {
      return serializeCookie(name, value, options);
    },
    clear() {
      return serializeCookie(name, '', { ...options, maxAge: 0 });
    },
  };
}
