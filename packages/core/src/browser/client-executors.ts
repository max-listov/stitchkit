/**
 * The two ways a typed client method reaches the server: through the Ky-based
 * HTTP adapter, or through a bare `fetch` — each planning the request from the
 * endpoint, applying its timeout and response mode, and turning an error
 * response into an `ApiError` with the same message and cause.
 */

import type { ClientRequestOptions } from '../contract/client-types';
import type { EndpointDef } from '../contract/define';
import { linkAbortSignals } from '../internal/abort-race';
import { type BackoffPolicy, backoffDelay } from '../internal/backoff';
import { assertTimerMs } from '../internal/deadline';
import { sleep } from '../internal/timers';
import { ApiError } from './api-error';
import { classifyBridgeTransportRetry } from './bridge-errors';
import { createRequestCancellation, RequestCancellationError } from './cancellation';
import type { ClientConfig, ContractClientConfig } from './client';
import { buildMultipartForm } from './client-multipart';
import { joinClientBaseUrl, planClientRequest } from './client-url';
import { parseContractStream } from './contract-stream';
import {
  classifyUnixTransportRetry,
  type HttpClient as HttpAdapter,
  isAbortLikeError,
  parseApiErrorBody,
  type RequestOptions,
} from './http';
import { resolveClientFetch } from './native-fetch';
import { responseTraceId } from './request-id';
import type { ClientFetch } from './transport';
import { uploadProgressRoute, withUploadProgress } from './upload-progress';

/** The contract decides whether the caller reads JSON, an empty reply or the wire bytes. */
function contractResponseType(endpoint: EndpointDef): RequestOptions['responseType'] {
  if (endpoint.rawResponse || 'stream' in endpoint) return 'response';
  return endpoint.output ? undefined : 'void';
}

/** Merge an endpoint's timeout and response mode into request options. */
function withTimeout(
  options: RequestOptions | undefined,
  endpoint: EndpointDef,
): RequestOptions | undefined {
  const responseType = contractResponseType(endpoint);
  const idempotent = declaredReplay(endpoint);
  if (endpoint.timeout === undefined && responseType === undefined && idempotent === undefined)
    return options;
  return {
    ...options,
    ...(endpoint.timeout !== undefined && { timeout: endpoint.timeout }),
    ...(responseType && { responseType }),
    ...(idempotent !== undefined && { idempotent }),
  };
}

/**
 * What the contract itself says about sending a call again: its `idempotent`,
 * else `false` for a declared `effect: 'write'` — a write is not repeated
 * because its method is `GET`. `undefined` leaves the decision to the method.
 */
function declaredReplay(endpoint: EndpointDef): boolean | undefined {
  if (endpoint.idempotent !== undefined) return endpoint.idempotent;
  if (endpoint.effect === 'write') return false;
  return undefined;
}

/**
 * Whether a call that never got an answer may be sent again: an endpoint that
 * says so, or a `GET`/`HEAD` that says nothing. `idempotent: false` or a
 * declared `effect: 'write'` is the endpoint refusing it, whatever its method.
 */
export function replaysAfterNetworkFailure(endpoint: EndpointDef): boolean {
  return declaredReplay(endpoint) ?? (endpoint.method === 'GET' || endpoint.method === 'HEAD');
}

/** `ClientConfig.retry.limit`: how many more sends, a non-negative integer. Default 2. */
function checkedReplayLimit(limit: number | undefined): number {
  if (limit === undefined) return 2;
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw new TypeError('[stitchkit] client: retry.limit is a non-negative integer');
  return limit;
}

/** The pause before the next send of a call that never got an answer. */
const REPLAY_BACKOFF: BackoffPolicy = { minDelayMs: 100, maxDelayMs: 2_000, jitter: 0.2 };

/**
 * Send `init` through `deliver`, again after a network failure when the
 * endpoint allows it, at most `limit` more times. A response — any status — is
 * an answer and is never repeated; a cancellation is never repeated either.
 */
async function deliverWithReplay(
  deliver: ClientFetch,
  url: string,
  init: RequestInit,
  replay: boolean,
  limit: number,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await deliver(url, init);
    } catch (error) {
      if (
        !replay ||
        attempt >= limit ||
        isAbortLikeError(error) ||
        init.signal?.aborted ||
        classifyUnixTransportRetry(error) === false ||
        classifyBridgeTransportRetry(error) === false
      )
        throw error;
      // A cancellation during the pause ends it at once, with the failure that started it.
      await sleep(backoffDelay(REPLAY_BACKOFF, attempt + 1), init.signal ?? undefined).catch(
        () => {
          throw error;
        },
      );
    }
  }
}

/**
 * Validate a resolved response through the endpoint's `output` schema when it
 * declares one — the contract's documented guarantee ("the client parses the
 * response through it"). The contract — not the server's runtime value — owns
 * whether a response exists. Applied on both client paths so the guarantee
 * cannot depend on which one a project wired.
 */
function withOutput(
  endpoint: EndpointDef,
  result: Promise<unknown>,
  abortStream?: () => void,
): Promise<unknown> {
  if (endpoint.rawResponse) return result;
  if ('stream' in endpoint && endpoint.stream) {
    return result.then(
      (value) => parseContractStream(value, endpoint.stream, abortStream ?? (() => undefined)),
      (error: unknown) => {
        abortStream?.();
        throw error;
      },
    );
  }
  const schema = endpoint.output;
  return result.then((value) => {
    if (!schema) {
      if (value === undefined || value === null) return undefined;
      throw new Error('Server returned data for an endpoint with no output contract');
    }
    if (value === undefined) {
      throw new Error('Server returned no body for an endpoint with an output contract');
    }
    return schema.parse(value);
  });
}

export type ClientRequestExecutor = (
  requestArgs: Record<string, unknown>,
  options?: ClientRequestOptions,
) => Promise<unknown>;

export function createHttpExecutor<K extends string>(
  endpoint: EndpointDef,
  prefix: string,
  client: HttpAdapter,
  config?: ContractClientConfig<K>,
): ClientRequestExecutor {
  const httpMethod = endpoint.method.toLowerCase() as
    | 'get'
    | 'head'
    | 'post'
    | 'put'
    | 'patch'
    | 'delete';
  return (requestArgs, options) => {
    const plan = planClientRequest(endpoint, prefix, requestArgs, config);
    const streamAbort = 'stream' in endpoint ? new AbortController() : undefined;
    const requestOptions = streamAbort
      ? {
          ...options,
          signal: options?.signal
            ? linkAbortSignals(options.signal, streamAbort.signal).signal
            : streamAbort.signal,
        }
      : options;
    const finishStream = streamAbort ? () => streamAbort.abort() : undefined;

    if (endpoint.multipart) {
      // Multipart uses the endpoint's declared body verb — a `PUT` upload must
      // not silently become a `POST` (the bare-fetch path already honours it).
      if (httpMethod === 'get' || httpMethod === 'head' || httpMethod === 'delete') {
        throw new Error(
          `Multipart endpoint ${endpoint.method} ${endpoint.path} must be POST / PUT / PATCH`,
        );
      }
      const formData = buildMultipartForm(endpoint.multipart, plan.remainingArgs);
      return withOutput(
        endpoint,
        client[httpMethod](plan.relativeUrl, formData, withTimeout(requestOptions, endpoint)),
        finishStream,
      );
    }

    if (httpMethod === 'get' || httpMethod === 'head') {
      return withOutput(
        endpoint,
        client[httpMethod](plan.relativeUrl, withTimeout(requestOptions, endpoint)),
        finishStream,
      );
    }

    if (httpMethod === 'delete') {
      return withOutput(
        endpoint,
        client.delete(plan.relativeUrl, withTimeout(requestOptions, endpoint)),
        finishStream,
      );
    }

    return withOutput(
      endpoint,
      client[httpMethod](
        plan.relativeUrl,
        Object.keys(plan.remainingArgs).length > 0 ? plan.remainingArgs : undefined,
        withTimeout(requestOptions, endpoint),
      ),
      finishStream,
    );
  };
}

export function createFetchExecutor<K extends string>(
  endpoint: EndpointDef,
  prefix: string,
  config: ClientConfig,
  contractConfig?: ContractClientConfig<K>,
): ClientRequestExecutor {
  const executeFetch = resolveClientFetch(config.fetch);
  const replayLimit = checkedReplayLimit(config.retry?.limit);
  assertTimerMs('HTTP client timeout', config.timeout);
  return async (requestArgs, options) => {
    const plan = planClientRequest(endpoint, prefix, requestArgs, contractConfig);
    const url = joinClientBaseUrl(config.baseUrl, plan.relativeUrl);

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(typeof config.headers === 'function' ? config.headers() : config.headers),
    };

    const hasBody =
      endpoint.method !== 'GET' &&
      endpoint.method !== 'HEAD' &&
      endpoint.method !== 'DELETE' &&
      !endpoint.multipart &&
      endpoint.input &&
      Object.keys(plan.remainingArgs).length > 0;

    if (hasBody) headers['Content-Type'] = 'application/json';
    // Chosen before starting the timeout so a refused route throws the caller's TypeError without leaking a timer.
    const progressRoute = options?.onUploadProgress
      ? uploadProgressRoute(config.fetch !== undefined)
      : undefined;

    // Apply the endpoint's declared `timeout` — the HttpClient path already did;
    // the bare-fetch path used to ignore it, so a declared timeout silently did
    // nothing here.
    // A stream's caller link lives until the stream ends: ending it aborts `streamAbort`, which
    // releases the links that follow it.
    const streamAbort = 'stream' in endpoint ? new AbortController() : undefined;
    const callerSignal =
      streamAbort && options?.signal
        ? linkAbortSignals(options.signal, streamAbort.signal).signal
        : (streamAbort?.signal ?? options?.signal);
    const openTimeoutMs = endpoint.timeout ?? config.timeout ?? 30_000;
    const cancellation = createRequestCancellation(callerSignal, openTimeoutMs);
    const bodyLifetime = endpoint.rawResponse || streamAbort ? 'handed-out' : 'read';

    try {
      const value = await cancellation.run(async (signal) => {
        const body = endpoint.multipart
          ? buildMultipartForm(endpoint.multipart, plan.remainingArgs)
          : hasBody
            ? JSON.stringify(plan.remainingArgs)
            : undefined;
        const deliver =
          options?.onUploadProgress && progressRoute
            ? withUploadProgress(executeFetch, options.onUploadProgress, {
                route: progressRoute,
                responseType: contractResponseType(endpoint),
              })
            : executeFetch;
        const res = await deliverWithReplay(
          deliver,
          url,
          {
            method: endpoint.method,
            headers,
            credentials: config.credentials,
            signal,
            ...(body !== undefined && { body }),
          },
          replaysAfterNetworkFailure(endpoint),
          replayLimit,
        );

        if (!res.ok) {
          await throwForErrorResponse(res, config, { error: res.statusText });
        }

        if (endpoint.rawResponse || ('stream' in endpoint && endpoint.stream)) return res;

        if (!endpoint.output) {
          const text = await res.text();
          if (text.length > 0) {
            throw new Error('Server returned data for an endpoint with no output contract');
          }
          return undefined;
        }

        return endpoint.output.parse(await res.json());
      }, bodyLifetime);
      // The stream is read after the open, as the HttpClient path does: `streamAbort` follows into
      // the caller signal, so its own abort on a refused response inside `run` read as the caller's.
      if ('stream' in endpoint && endpoint.stream) {
        return parseContractStream(value, endpoint.stream, () => streamAbort?.abort());
      }
      return value;
    } catch (error) {
      streamAbort?.abort();
      if (error instanceof RequestCancellationError) {
        throw new ApiError(error.origin === 'caller' ? 'REQUEST_ABORTED' : 'REQUEST_TIMEOUT', {
          status: 0,
          message: error.message,
          ...(error.cause !== undefined && { cause: error.cause }),
        });
      }
      if (ApiError.is(error)) throw error;
      const message = error instanceof Error ? error.message : undefined;
      throw new ApiError('UNKNOWN_ERROR', {
        status: 0,
        details: message ? { message } : undefined,
        message,
        cause: error,
      });
    }
  };
}

/** Read an error response, fire `onError`, throw a typed `ApiError` — never returns. */
async function throwForErrorResponse(
  res: Response,
  config: ClientConfig,
  fallbackBody: unknown,
): Promise<never> {
  const body = await res.json().catch(() => fallbackBody);
  config.onError?.(res.status, body);
  const parsed = parseApiErrorBody(body);
  if (parsed) {
    throw new ApiError(parsed.code, {
      status: res.status,
      details: parsed.details,
      message: parsed.message,
      hint: parsed.hint,
      traceId: responseTraceId(res),
      retryable: parsed.retryable,
    });
  }
  throw new ApiError('HTTP_ERROR', {
    status: res.status,
    details: { body },
    traceId: responseTraceId(res),
  });
}
