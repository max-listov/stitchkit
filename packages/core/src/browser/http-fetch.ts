/**
 * The fetch side of the Ky client: which fetch each attempt goes through, the
 * query string, and how a response becomes the value a caller asked for.
 */
import type { Options, ResponsePromise } from 'ky';
import { transportResult } from '../internal/typed';
import type { ClientFetch } from './transport';

export type ParamValue = string | number | boolean | undefined;
export type ParamArrayValue = Array<string | number>;

/**
 * Keep Next.js request memoization for the first attempt, then make each Ky
 * retry observable as a new transport attempt. Next only treats a signal that
 * survives in the second fetch argument at its dedupe boundary as an opt-out.
 * Its patched fetch merges `init` into Request inputs first, so retries use a
 * URL plus a materialized init while the untouched first attempt keeps the
 * exact Ky Request.
 */
export function createRetryAwareFetch(
  transportFetch: ClientFetch,
  unix?: string,
): NonNullable<Options['fetch']> {
  const runtimeFetch = transportFetch;
  let attempt = 0;

  return (input, init) => {
    attempt += 1;
    // The socket option must ride in materialized `fetch(url, init)` form —
    // `fetch(Request, { unix })` is undocumented in Bun — so a unix client
    // skips the pass-through even on the first attempt. (That pass-through
    // guards Next.js request memoization, which never applies to a local
    // daemon dial.) Without `unix` the behavior is bit-for-bit unchanged.
    if (unix === undefined && attempt === 1) {
      return runtimeFetch(input, init);
    }
    if (!(input instanceof Request)) {
      if (unix === undefined) return runtimeFetch(input, init);
      const unixInit: RequestInit & { unix: string } = { ...init, unix };
      return runtimeFetch(input, unixInit);
    }
    // Undici requires `duplex: 'half'` when a Request body stream is moved into
    // URL + RequestInit form. Keep it in a spread because `duplex` is a runtime
    // Fetch field that is not yet present in every TypeScript DOM lib.
    const streamedBody = input.body ? { body: input.body, duplex: 'half' } : {};
    const materialized: RequestInit & { unix?: string } = {
      ...init,
      ...(unix !== undefined && { unix }),
      method: input.method,
      headers: input.headers,
      ...streamedBody,
      cache: input.cache,
      credentials: input.credentials,
      integrity: input.integrity,
      keepalive: input.keepalive,
      mode: input.mode,
      redirect: input.redirect,
      referrer: input.referrer,
      referrerPolicy: input.referrerPolicy,
      signal: input.signal,
    };
    return runtimeFetch(input.url, materialized);
  };
}

/** Query parameters as a search string; `undefined` drops a key, an array repeats it. */
export function searchParamsOf(
  params: Record<string, ParamValue | ParamArrayValue>,
): URLSearchParams | undefined {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) searchParams.append(key, String(item));
    } else {
      searchParams.set(key, String(value));
    }
  }
  return searchParams.size > 0 ? searchParams : undefined;
}

/** Read a response as the caller's `responseType` asked: parsed JSON by default. */
export async function readResponse<T>(
  pending: ResponsePromise,
  responseType: 'json' | 'blob' | 'response' | 'void' | undefined,
): Promise<T> {
  if (responseType === 'blob') return transportResult<T>(await pending.blob());
  // No parsing, no 204 special-case — the caller owns the body.
  if (responseType === 'response') return transportResult<T>(await pending);
  const response = await pending;
  if (responseType === 'void') {
    const text = await response.text();
    if (text.length > 0) {
      throw new Error('Server returned data for an endpoint with no output contract');
    }
  }
  if (
    responseType === 'void' ||
    response.status === 204 ||
    response.headers.get('content-length') === '0'
  ) {
    return transportResult<T>(undefined);
  }
  return await response.json<T>();
}
