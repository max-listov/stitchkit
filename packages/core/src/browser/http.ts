import ky, {
  isHTTPError,
  isNetworkError,
  isTimeoutError,
  type KyInstance,
  type Options,
} from 'ky';
import type { ErrorEnvelope } from '../contract';
import { isRecord, transportResult } from '../internal/typed';
import { createTraceContext, formatTraceparent } from '../observability/trace';
import { createRequestCancellation, RequestCancellationError } from './cancellation';
import { responseTraceId } from './request-id';
import type { ClientFetch } from './transport';

export type ApiEvent =
  | { type: 'unauthorized' }
  | { type: 'network_error' }
  | { type: 'logout' };

export type ApiEventListener = (event: ApiEvent) => void;

/** Exact pathname policy used to suppress an expected `401` event. */
export type UnauthorizedMatcher = (pathname: string) => boolean;

/**
 * Global brand for cross-realm / cross-chunk identification, mirroring
 * `AppError`'s (→ ADR 0032). The published dist bundles this class into more
 * than one chunk (the browser build and the server build each carry a copy),
 * so an `ApiError` thrown by a client from one chunk fails `instanceof`
 * against the other chunk's class — which silently killed the
 * `ApiError → AppError` conversion in `implementRemote` and flattened every
 * remote failure to `INTERNAL_SERVER_ERROR`.
 */
const API_ERROR_BRAND = Symbol.for('stitchkit.ApiError');

/**
 * The text an `ApiError` carries when nothing supplied one.
 *
 * The old fallback was `API Error: ${code}`, which reads like an explanation and
 * is not one: a caller could not tell "the origin explained this failure" from
 * "nothing explained it", because `message` was a plausible non-empty string
 * either way. Those are different answers, and merging them is what sent one
 * consumer hunting a permission refusal that never happened — the code alone
 * read as one.
 *
 * Fixed in the text rather than in a field beside it, because the text is the
 * channel that survives a hop: `implementRemote` copies `message` into the
 * `AppError` it re-throws, so a fabricated line crosses to the NEXT consumer as
 * though the origin had written it, while a structural flag would stop at the
 * boundary — dead exactly where it is needed.
 *
 * An empty string counts as unsupplied: it explains nothing either, and `??`
 * alone would have let it through.
 */
function messageForCode(code: string, message: string | undefined): string {
  return message !== undefined && message.length > 0
    ? message
    : `${code} (no message supplied)`;
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number = 0,
    public readonly details?: unknown,
    message?: string,
    public readonly hint?: string,
    public readonly traceId?: string,
    options?: ErrorOptions,
  ) {
    super(messageForCode(code, message), options);
    this.name = 'ApiError';
    // Non-enumerable — invisible to JSON / spread, present for `is()`.
    Object.defineProperty(this, API_ERROR_BRAND, { value: true });
  }

  static is(error: unknown): error is ApiError {
    return typeof error === 'object' && error !== null && API_ERROR_BRAND in error;
  }
}

/**
 * A refusal the client raised itself, in the shape the server uses for the same failure.
 *
 * Before this, the client refused a bad argument in three shapes across two timings: a plain `Error`
 * rejected on one transport, the same plain `Error` thrown **synchronously** on the other, and a
 * missing multipart file reported as `UNKNOWN_ERROR` — the code whose whole meaning is *this client
 * cannot tell you what happened*, on the one refusal where dispatch provably never happened, while
 * the client guide instructs the reader never to conclude anything from that code.
 *
 * `status: 0` already means "this never reached the server" (`REQUEST_ABORTED`, `REQUEST_TIMEOUT`),
 * so `VALIDATION_ERROR` with `status: 0` reads as "refused here" against the server's `400` with no
 * new field and no new name. `details.issues` carries the same `{ path, code, message }` a 400
 * carries, so one rendering serves both.
 */
export function refuseLocally(path: string, message: string): ApiError {
  return new ApiError(
    'VALIDATION_ERROR',
    0,
    { issues: [{ path, code: 'invalid_type', message }] },
    message,
  );
}

/**
 * An abort or a deadline the caller chose — `RequestCancellationError`, a
 * `DOMException` or any error named `AbortError` / `TimeoutError`. Never a
 * reason to retry, on either side of the fetch.
 */
export function isAbortLikeError(error: unknown): boolean {
  if (error instanceof RequestCancellationError) return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

/** @internal Narrow adapter for a Bun fetch error Ky does not classify. */
export function shouldRetryBunNetworkError(error: unknown): true | undefined {
  if (
    ApiError.is(error) ||
    isHTTPError(error) ||
    isNetworkError(error) ||
    isTimeoutError(error) ||
    isAbortLikeError(error)
  ) {
    return undefined;
  }
  if (!(error instanceof Error)) return undefined;

  const code = Object.getOwnPropertyDescriptor(error, 'code');
  return code && 'value' in code && code.value === 'ConnectionRefused' ? true : undefined;
}

/**
 * Parse a response body into an `ErrorEnvelope['error']` — the default
 * `HttpClientConfig.parseError`. Returns `null` when the body is not a
 * stitchkit error envelope. Shared by `createHttpClient` and `createClient`.
 */
export function parseApiErrorBody(body: unknown): ErrorEnvelope['error'] | null {
  if (!isRecord(body) || !isRecord(body.error)) return null;
  const error = body.error;
  if (typeof error.code !== 'string') return null;
  return {
    code: error.code,
    message: typeof error.message === 'string' ? error.message : undefined,
    details: error.details,
    hint: typeof error.hint === 'string' ? error.hint : undefined,
  };
}

export type HeaderProvider =
  | Record<string, string>
  | (() => Record<string, string> | null | undefined);

/** Configuration for `createHttpClient`. */
export interface HttpClientConfig {
  baseUrl: string;
  timeout?: number;
  credentials?: RequestCredentials;
  /**
   * Transport retry. `limit` counts retries after the initial attempt, so the
   * default `2` permits at most three total attempts. Defaults: GET only and
   * network errors only (`statusCodes: []`). Retrying a server that responded
   * belongs in the data layer unless `methods` / `statusCodes` explicitly
   * expand this transport policy.
   */
  retry?: { limit?: number; methods?: string[]; statusCodes?: number[] };
  parseError?: (body: unknown) => ErrorEnvelope['error'] | null;
  /** Contract-derived pathname matchers whose expected `401` must not emit an event. */
  suppressUnauthorizedFor?: readonly UnauthorizedMatcher[];
  /**
   * Extra headers added to every request. A function is re-evaluated per
   * request — use it for runtime tokens (e.g. a short-lived auth token).
   */
  headers?: HeaderProvider;
  /**
   * Emit a W3C `traceparent` header on every request — a fresh root trace per
   * request. The stitchkit server continues an inbound `traceparent`
   * (`resolveTraceContext`), so with this on, a browser call, its HTTP handler
   * and every nested tool call share one trace id end-to-end. A `traceparent`
   * already set (via `headers`) wins — the client never overwrites it.
   * Default `false`.
   */
  trace?: boolean;
  /** Explicit Fetch-compatible transport, for example `createUnixClientTransport().fetch`. */
  fetch?: ClientFetch;
  /**
   * Hear the `X-Build-Id` of every response — a `createReleaseWatcher` from
   * `stitchkit/release`, which reloads the page when the server names a build
   * this bundle is not. The channel a client has with no socket at all.
   */
  release?: { observe(buildId: string | null): void };
  /**
   * Dial a unix domain socket instead of TCP (Bun runtime only). Other runtimes
   * fail before dispatch; use `createUnixClientTransport().fetch` for the
   * portable Bun/Node path. `baseUrl` stays required as the path/prefix source;
   * its host is ignored by Bun's socket transport.
   */
  unix?: string;
}

type ParamValue = string | number | boolean | undefined;
type ParamArrayValue = Array<string | number>;

/**
 * Keep Next.js request memoization for the first attempt, then make each Ky
 * retry observable as a new transport attempt. Next only treats a signal that
 * survives in the second fetch argument at its dedupe boundary as an opt-out.
 * Its patched fetch merges `init` into Request inputs first, so retries use a
 * URL plus a materialized init while the untouched first attempt keeps the
 * exact Ky Request.
 */
function createRetryAwareFetch(
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

export interface RequestOptions {
  params?: Record<string, ParamValue | ParamArrayValue>;
  timeout?: number;
  signal?: AbortSignal;
  /**
   * How to read the body. `'response'` hands back the untouched `Response` —
   * what a `raw` endpoint answers with, and strictly more than `'blob'`: the
   * caller still gets `.blob()` / `.body`, plus the headers where
   * `Content-Disposition` (the download filename) lives.
   */
  responseType?: 'json' | 'blob' | 'response' | 'void';
}

/** The HTTP transport adapter `createClient` builds typed methods on. */
export interface HttpClient {
  get<T>(url: string, options?: RequestOptions): Promise<T>;
  head<T>(url: string, options?: RequestOptions): Promise<T>;
  post<T>(url: string, data?: unknown, options?: RequestOptions): Promise<T>;
  put<T>(url: string, data?: unknown, options?: RequestOptions): Promise<T>;
  patch<T>(url: string, data?: unknown, options?: RequestOptions): Promise<T>;
  delete<T>(url: string, options?: RequestOptions): Promise<T>;
  setServerContext(cookies: string): void;
  subscribe(listener: ApiEventListener): () => void;
  /** Mark the client as logged out — suppresses further `unauthorized` events. */
  logout(): void;
  /** Clear the logged-out flag — call after a successful re-login. */
  resetLogoutState(): void;
}

/** A framework-created HTTP client that can also seed contract URL builders. */
export interface ConfiguredHttpClient extends HttpClient {
  readonly baseUrl: string;
}

/**
 * Create a Ky-based `HttpClient` — the transport `createClient` builds on.
 * Handles cookie auth, SSR cookie forwarding, error parsing into `ApiError`, a
 * `401 → unauthorized` event stream, and safe transport retry.
 */
export function createHttpClient(config: HttpClientConfig): ConfiguredHttpClient {
  if (config.fetch && config.unix) {
    throw new TypeError('HttpClientConfig.fetch and unix are mutually exclusive');
  }
  if (config.unix !== undefined) {
    if (!config.unix.startsWith('/') || config.unix.includes('\0')) {
      throw new TypeError('HttpClientConfig.unix must be an absolute Unix socket path');
    }
    if (typeof Reflect.get(globalThis, 'Bun') !== 'object') {
      throw new TypeError(
        'HttpClientConfig.unix requires Bun; on Bun or Node use createUnixClientTransport().fetch for an explicit portable transport',
      );
    }
  }
  let ssrCookies: string | null = null;
  let isLoggedOut = false;
  const listeners = new Set<ApiEventListener>();
  const suppressUnauthorizedFor = config.suppressUnauthorizedFor ?? [];

  const parseError = config.parseError ?? parseApiErrorBody;

  function emit(event: ApiEvent): void {
    for (const fn of listeners) {
      try {
        fn(event);
      } catch {
        /* ignore listener errors */
      }
    }
  }

  const client: KyInstance = ky.create({
    prefix: config.baseUrl,
    credentials: config.credentials ?? 'include',
    timeout: false,
    // Transport retry — only what's safe and invisible: a connection that
    // never landed (network error), on idempotent GET. NOT 5xx — a server
    // that responded with an error is the data layer's call. Empty
    // `statusCodes` = retry network failures only.
    retry: {
      limit: config.retry?.limit ?? 2,
      methods: config.retry?.methods ?? ['get'],
      statusCodes: config.retry?.statusCodes ?? [],
      shouldRetry: ({ error }) => shouldRetryBunNetworkError(error),
    },
    hooks: {
      beforeRequest: [
        ({ request }) => {
          if (ssrCookies) {
            request.headers.set('Cookie', ssrCookies);
          }
          const extra =
            typeof config.headers === 'function' ? config.headers() : config.headers;
          if (extra) {
            for (const [key, value] of Object.entries(extra)) {
              request.headers.set(key, value);
            }
          }
          // A fresh root trace per request; a caller-set traceparent wins.
          if (config.trace && !request.headers.has('traceparent')) {
            request.headers.set('traceparent', formatTraceparent(createTraceContext()));
          }
        },
      ],
      afterResponse: [
        async ({ request, response }) => {
          // Best-effort, like the trace id: a watcher that throws must not
          // turn the response that carried the header into a failed request.
          if (config.release) {
            try {
              config.release.observe(response.headers.get('x-build-id'));
            } catch {
              // The watcher's failure is its own.
            }
          }
          if (response.status === 401) {
            const url = new URL(request.url).pathname;
            if (!isLoggedOut && !suppressUnauthorizedFor.some((matches) => matches(url))) {
              isLoggedOut = true;
              emit({ type: 'unauthorized' });
            }
          }
          if (!response.ok) {
            const body = await response
              .clone()
              .json()
              .catch(() => null);
            if (body) {
              const parsed = parseError(body);
              if (parsed) {
                throw new ApiError(
                  parsed.code,
                  response.status,
                  parsed.details,
                  parsed.message,
                  parsed.hint,
                  responseTraceId(response),
                );
              }
            }
          }
        },
      ],
    },
  });

  async function request<T>(
    method: 'get' | 'head' | 'post' | 'put' | 'patch' | 'delete',
    url: string,
    data?: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    const cancellation = createRequestCancellation(
      options.signal,
      options.timeout ?? config.timeout ?? 30_000,
    );
    const kyOptions: Options = {
      fetch: createRetryAwareFetch(
        config.fetch ?? globalThis.fetch.bind(globalThis),
        config.unix,
      ),
      timeout: false,
      signal: cancellation.signal,
    };

    if (options.params) {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(options.params)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const item of value) searchParams.append(key, String(item));
        } else {
          searchParams.set(key, String(value));
        }
      }
      if (searchParams.size > 0) {
        kyOptions.searchParams = searchParams;
      }
    }

    if (data instanceof FormData) {
      kyOptions.body = data;
    } else if (data !== undefined) {
      kyOptions.json = data;
    }

    try {
      return await cancellation.run(async () => {
        if (options.responseType === 'blob') {
          return transportResult<T>(await client[method](url, kyOptions).blob());
        }
        if (options.responseType === 'response') {
          // No parsing, no 204 special-case — the caller owns the body.
          return transportResult<T>(await client[method](url, kyOptions));
        }
        const response = await client[method](url, kyOptions);
        if (options.responseType === 'void') {
          const text = await response.text();
          if (text.length > 0) {
            throw new Error('Server returned data for an endpoint with no output contract');
          }
        }
        if (
          options.responseType === 'void' ||
          response.status === 204 ||
          response.headers.get('content-length') === '0'
        ) {
          return transportResult<T>(undefined);
        }
        return await response.json<T>();
      });
    } catch (error) {
      if (error instanceof RequestCancellationError) {
        throw new ApiError(
          error.cause === 'caller' ? 'REQUEST_ABORTED' : 'REQUEST_TIMEOUT',
          0,
          undefined,
          error.message,
        );
      }
      if (ApiError.is(error)) throw error;
      emit({ type: 'network_error' });
      const response = isHTTPError(error) ? error.response : undefined;
      const status = response?.status ?? 0;
      const msg = error instanceof Error ? error.message : undefined;
      // The message and the `cause` go to the same places the bare-fetch path
      // sends them (`createFetchExecutor`). This path used to pass `undefined`
      // for both and file the real text under `details.message` alone, so the
      // ky adapter answered `API Error: UNKNOWN_ERROR` where the bare-fetch
      // path answered "Unable to connect" — same failure, same client, two
      // different stories.
      throw new ApiError(
        'UNKNOWN_ERROR',
        status,
        msg ? { message: msg } : undefined,
        msg,
        undefined,
        responseTraceId(response),
        { cause: error },
      );
    }
  }

  return {
    baseUrl: config.baseUrl,
    get: <T>(url: string, options?: RequestOptions) =>
      request<T>('get', url, undefined, options),
    head: <T>(url: string, options?: RequestOptions) =>
      request<T>('head', url, undefined, options),
    post: <T>(url: string, data?: unknown, options?: RequestOptions) =>
      request<T>('post', url, data, options),
    put: <T>(url: string, data?: unknown, options?: RequestOptions) =>
      request<T>('put', url, data, options),
    patch: <T>(url: string, data?: unknown, options?: RequestOptions) =>
      request<T>('patch', url, data, options),
    delete: <T>(url: string, options?: RequestOptions) =>
      request<T>('delete', url, undefined, options),
    setServerContext(cookies: string) {
      ssrCookies = cookies;
    },
    subscribe(listener: ApiEventListener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    logout() {
      isLoggedOut = true;
      emit({ type: 'logout' });
    },
    resetLogoutState() {
      isLoggedOut = false;
    },
  };
}
