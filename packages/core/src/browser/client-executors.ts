/**
 * The two ways a typed client method reaches the server: through the Ky-based
 * HTTP adapter, or through a bare `fetch` — each planning the request from the
 * endpoint, applying its timeout and response mode, and turning an error
 * response into an `ApiError` with the same message and cause.
 */

import type { ClientRequestOptions } from '../contract/client-types';
import type { EndpointDef } from '../contract/define';
import { createRequestCancellation, RequestCancellationError } from './cancellation';
import type { ClientConfig, ContractClientConfig } from './client';
import { buildMultipartForm } from './client-multipart';
import { joinClientBaseUrl, planClientRequest } from './client-url';
import { parseContractStream } from './contract-stream';
import {
  ApiError,
  type HttpClient as HttpAdapter,
  parseApiErrorBody,
  type RequestOptions,
} from './http';
import { responseTraceId } from './request-id';

/** Merge an endpoint's timeout and response mode into request options. */
function withTimeout(
  options: RequestOptions | undefined,
  endpoint: EndpointDef,
): RequestOptions | undefined {
  // A raw endpoint answers with bytes — parsing it as JSON is how the old
  // hand-rolled transports produced empty objects. → ADR 0038.
  const responseType: RequestOptions['responseType'] =
    endpoint.rawResponse || 'stream' in endpoint
      ? 'response'
      : endpoint.output
        ? undefined
        : 'void';
  if (endpoint.timeout === undefined && responseType === undefined) return options;
  return {
    ...options,
    ...(endpoint.timeout !== undefined && { timeout: endpoint.timeout }),
    ...(responseType && { responseType }),
  };
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
      (value) => {
        if (!(value instanceof Response)) {
          abortStream?.();
          throw new Error('Streaming endpoint did not return a Response');
        }
        return parseContractStream(value, endpoint.stream, abortStream ?? (() => undefined));
      },
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
            ? AbortSignal.any([options.signal, streamAbort.signal])
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
  const executeFetch = config.fetch ?? globalThis.fetch;
  return async (requestArgs, options) => {
    const plan = planClientRequest(endpoint, prefix, requestArgs, contractConfig);
    const url = joinClientBaseUrl(config.baseUrl, plan.relativeUrl);

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(typeof config.headers === 'function' ? config.headers() : config.headers),
    };

    // Apply the endpoint's declared `timeout` — the HttpClient path already did;
    // the bare-fetch path used to ignore it, so a declared timeout silently did
    // nothing here.
    const streamAbort = 'stream' in endpoint ? new AbortController() : undefined;
    const requestSignal = streamAbort
      ? options?.signal
        ? AbortSignal.any([options.signal, streamAbort.signal])
        : streamAbort.signal
      : options?.signal;
    const openTimeoutMs = endpoint.timeout ?? config.timeout ?? 30_000;
    const cancellation = streamAbort
      ? {
          signal: requestSignal,
          async run<T>(operation: (signal?: AbortSignal) => Promise<T>): Promise<T> {
            let timedOut = false;
            const timer = setTimeout(() => {
              timedOut = true;
              streamAbort.abort(new DOMException('Request timed out', 'TimeoutError'));
            }, openTimeoutMs);
            try {
              if (options?.signal?.aborted) throw new RequestCancellationError('caller');
              return await operation(requestSignal);
            } catch (error) {
              if (timedOut) throw new RequestCancellationError('timeout');
              if (options?.signal?.aborted) throw new RequestCancellationError('caller');
              throw error;
            } finally {
              clearTimeout(timer);
            }
          },
        }
      : createRequestCancellation(requestSignal, openTimeoutMs);

    const hasBody =
      endpoint.method !== 'GET' &&
      endpoint.method !== 'HEAD' &&
      endpoint.method !== 'DELETE' &&
      !endpoint.multipart &&
      endpoint.input &&
      Object.keys(plan.remainingArgs).length > 0;

    if (hasBody) headers['Content-Type'] = 'application/json';

    try {
      return await cancellation.run(async (signal) => {
        const body = endpoint.multipart
          ? buildMultipartForm(endpoint.multipart, plan.remainingArgs)
          : hasBody
            ? JSON.stringify(plan.remainingArgs)
            : undefined;
        const res = await executeFetch(url, {
          method: endpoint.method,
          headers,
          credentials: config.credentials,
          signal,
          ...(body !== undefined && { body }),
        });

        if (!res.ok) {
          await throwForErrorResponse(res, config, { error: res.statusText });
        }

        if (endpoint.rawResponse) return res;

        if ('stream' in endpoint && endpoint.stream) {
          return parseContractStream(res, endpoint.stream, () => streamAbort?.abort());
        }

        if (!endpoint.output) {
          const text = await res.text();
          if (text.length > 0) {
            throw new Error('Server returned data for an endpoint with no output contract');
          }
          return undefined;
        }

        return endpoint.output.parse(await res.json());
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
      const message = error instanceof Error ? error.message : undefined;
      throw new ApiError(
        'UNKNOWN_ERROR',
        0,
        message ? { message } : undefined,
        message,
        undefined,
        undefined,
        { cause: error },
      );
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
    throw new ApiError(
      parsed.code,
      res.status,
      parsed.details,
      parsed.message,
      parsed.hint,
      responseTraceId(res),
    );
  }
  throw new ApiError(
    'HTTP_ERROR',
    res.status,
    { body },
    undefined,
    undefined,
    responseTraceId(res),
  );
}
