import ky, { isHTTPError, type KyInstance, type Options } from 'ky';
import type { ErrorEnvelope } from '../contract';
import { isRecord } from '../internal/typed';
import { createTraceContext, formatTraceparent } from '../observability/trace';
import { responseTraceId } from './request-id';

export type ApiEvent =
  | { type: 'unauthorized' }
  | { type: 'network_error' }
  | { type: 'logout' };

export type ApiEventListener = (event: ApiEvent) => void;

/** Exact pathname policy used to suppress an expected `401` event. */
export type UnauthorizedMatcher = (pathname: string) => boolean;

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number = 0,
    public readonly details?: unknown,
    message?: string,
    public readonly hint?: string,
    public readonly traceId?: string,
  ) {
    super(message ?? `API Error: ${code}`);
    this.name = 'ApiError';
  }

  static is(error: unknown): error is ApiError {
    return error instanceof ApiError;
  }
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
   * Transport retry. Defaults: 2 attempts, GET only, network errors only
   * (empty `statusCodes`). Retrying a server that *responded* (5xx) belongs
   * in the data layer (e.g. TanStack Query), not the transport — keeping it
   * here too would multiply attempts. Override per project if really needed.
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
}

type ParamValue = string | number | boolean | undefined;
type ParamArrayValue = Array<string | number>;

export interface RequestOptions {
  params?: Record<string, ParamValue | ParamArrayValue>;
  timeout?: number;
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
    timeout: config.timeout ?? 30_000,
    // Transport retry — only what's safe and invisible: a connection that
    // never landed (network error), on idempotent GET. NOT 5xx — a server
    // that responded with an error is the data layer's call. Empty
    // `statusCodes` = retry network failures only.
    retry: {
      limit: config.retry?.limit ?? 2,
      methods: config.retry?.methods ?? ['get'],
      statusCodes: config.retry?.statusCodes ?? [],
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
    const kyOptions: Options = {
      timeout: options.timeout,
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
      if (options.responseType === 'blob') {
        return client[method](url, kyOptions).blob() as Promise<T>;
      }
      if (options.responseType === 'response') {
        // No parsing, no 204 special-case — the caller owns the body. Errors
        // still surface as `ApiError` through the catch below, so a failed
        // download does not masquerade as a zero-byte file.
        return (await client[method](url, kyOptions)) as T;
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
        return undefined as T;
      }
      return response.json<T>();
    } catch (error) {
      if (ApiError.is(error)) throw error;
      const isAbort = error instanceof Error && error.name === 'AbortError';
      if (!isAbort) {
        emit({ type: 'network_error' });
      }
      const response = !isAbort && isHTTPError(error) ? error.response : undefined;
      const status = response?.status ?? 0;
      const msg = error instanceof Error ? error.message : undefined;
      throw new ApiError(
        'UNKNOWN_ERROR',
        status,
        msg ? { message: msg } : undefined,
        undefined,
        undefined,
        responseTraceId(response),
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
