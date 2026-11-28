import { isHTTPError } from 'ky';
import { ApiError } from './api-error';
import { RequestCancellationError } from './cancellation';
import type { ApiEvent, HttpClientConfig } from './http';
import { responseTraceId } from './request-id';

/** `fetch` and `unix` are two transports; a unix socket needs Bun's own fetch. */
export function assertTransportChoice(config: HttpClientConfig): void {
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
}

/**
 * The `ApiError` a failed request becomes. A cancellation is the caller's own
 * and emits nothing; anything else that is not already an `ApiError` is a
 * transport failure and emits `network_error`.
 */
export function requestFailure(error: unknown, emit: (event: ApiEvent) => void): ApiError {
  if (error instanceof RequestCancellationError) {
    return new ApiError(error.origin === 'caller' ? 'REQUEST_ABORTED' : 'REQUEST_TIMEOUT', {
      status: 0,
      message: error.message,
      ...(error.cause !== undefined && { cause: error.cause }),
    });
  }
  if (ApiError.is(error)) return error;
  emit({ type: 'network_error' });
  const response = isHTTPError(error) ? error.response : undefined;
  const status = response?.status ?? 0;
  const msg = error instanceof Error ? error.message : undefined;
  return new ApiError('UNKNOWN_ERROR', {
    status,
    details: msg ? { message: msg } : undefined,
    message: msg,
    traceId: responseTraceId(response),
    cause: error,
  });
}

/** The body Ky sends for `json`, as the React Native upload route must send it. */
export function jsonBodyOf(data: unknown): string | null {
  return data === undefined ? null : JSON.stringify(data);
}

/** Ky's pre-read error body: parsed JSON, or text a server sent without a JSON type. */
export function errorBodyOf(data: unknown): unknown {
  if (typeof data !== 'string') return data ?? null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}
