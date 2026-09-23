/**
 * The last phase of a contract endpoint: turn what its handler returned into
 * the response — a raw `Response`, a contract stream, or validated data.
 * Every throw here belongs to the endpoint's error path, which the caller owns.
 */

import type { ResponseMetadata, RuntimeContext } from '../contract/define';
import { AppError } from '../contract/errors';
import { validateDeclaredOutput } from '../contract/normalize';
import { contractStreamResponse } from './contract-stream';
import type { HandlerState, RequestState } from './handler-state';
import { applyCors, requestCorsHeaders } from './middleware/cors';
import { applyResponseMetadata } from './response-metadata';
import type { RouteMatch } from './router';

/** What the handler phase hands over: its context, its result, and what it armed. */
export interface EndpointOutcome {
  ctx: RuntimeContext;
  match: RouteMatch;
  result: unknown;
  responseMetadata: ResponseMetadata | undefined;
  streamAbort: AbortController | undefined;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return false;
  }
  return typeof Reflect.get(value, Symbol.asyncIterator) === 'function';
}

export async function endpointResponse<TServer>(
  state: HandlerState<TServer>,
  request: RequestState<TServer>,
  outcome: EndpointOutcome,
): Promise<Response> {
  const { method } = outcome.match;
  // A raw endpoint owns its response: no `afterHandle` (that hook
  // transforms *data*, and there is none), no output validation, no
  // serialization. Only CORS is applied — in place, so a `206` keeps its
  // body intact. Everything before this point ran normally, which is the
  // whole point: the auth gate, params and input validation are the same
  // as for any endpoint. → ADR 0038.
  if (method.rawResponse) return rawEndpointResponse(state, request, outcome);

  // A contract stream owns validated protocol frames, not a data value.
  // Like a raw response it skips data transforms/serialization, while the
  // framework still owns schema validation, bounds and cancellation.
  if (method.stream) return streamEndpointResponse(state, request, outcome);

  return dataEndpointResponse(state, request, outcome);
}

function rawEndpointResponse<TServer>(
  state: HandlerState<TServer>,
  request: RequestState<TServer>,
  { match: { method }, result }: EndpointOutcome,
): Response {
  if (!(result instanceof Response)) {
    throw new AppError(
      'INTERNAL_SERVER_ERROR',
      `Raw endpoint ${method.serviceName}.${method.key} must return a Response`,
      500,
    );
  }
  const response =
    method.method === 'HEAD'
      ? new Response(null, {
          status: result.status,
          statusText: result.statusText,
          headers: result.headers,
        })
      : result;
  const rawRes = applyCors(response, state.cors, request.req);
  request.complete(rawRes.status);
  return rawRes;
}

async function streamEndpointResponse<TServer>(
  state: HandlerState<TServer>,
  request: RequestState<TServer>,
  { match: { method, pathParams }, result, streamAbort }: EndpointOutcome,
): Promise<Response> {
  const { req, server, clientIp } = request;
  if (!method.stream || !streamAbort || !isAsyncIterable(result)) {
    streamAbort?.abort();
    throw new AppError(
      'INTERNAL_SERVER_ERROR',
      `Streaming endpoint ${method.serviceName}.${method.key} must return an AsyncIterable`,
      500,
    );
  }
  const response = await contractStreamResponse(
    req,
    { params: pathParams, server, ipAddress: clientIp.socketIp },
    result,
    method.stream,
    streamAbort,
  );
  const withCors = applyCors(response, state.cors, req);
  request.complete(withCors.status);
  return withCors;
}

async function dataEndpointResponse<TServer>(
  state: HandlerState<TServer>,
  request: RequestState<TServer>,
  {
    ctx,
    match: { method, groupHooks },
    result: handlerResult,
    responseMetadata,
  }: EndpointOutcome,
): Promise<Response> {
  const { hooks, config, cors, warn } = state;
  const { req } = request;
  let result = handlerResult;
  if (groupHooks?.afterHandle) {
    const transformed = await groupHooks.afterHandle(ctx, result, method);
    if (transformed !== undefined) result = transformed;
  }
  if (hooks?.afterHandle) {
    const transformed = await hooks.afterHandle(ctx, result, method);
    if (transformed !== undefined) result = transformed;
  }

  // The mirror image of the raw branch, and the reason this endpoint kind
  // exists: a `Response` on the data path used to be serialized into `{}`
  // with status 200 — headers, status and body gone, no error anywhere.
  // Checked *after* the hooks so it also catches an `afterHandle` that
  // returns one; the type forbids the handler doing it, but a service
  // assembled past the types, and any hook, still can.
  if (result instanceof Response) {
    throw new AppError(
      'INTERNAL_SERVER_ERROR',
      `${method.serviceName}.${method.key} produced a Response on the data path — only a \`rawResponse: true\` endpoint may return one (an afterHandle hook must return data)`,
      500,
    );
  }

  // A handler returning the wrong shape — including data with no declared
  // output, or undefined for a declared JSON output — is a server fault.
  // The same invariant runs on tool transports below the HTTP framing.
  const checked = validateDeclaredOutput(
    method.outputSchema,
    result,
    config.warnOnOutputStrip && method.outputSchema
      ? (paths) => {
          // The endpoint identity is in the message on purpose: a dot-path
          // alone is not actionable without knowing which handler produced it.
          warn(
            `[stitchkit] output strip ${method.serviceName}.${method.key}: ${paths.join(', ')}`,
          );
        }
      : undefined,
  );
  if (!checked.ok) {
    throw new AppError('INTERNAL_SERVER_ERROR', checked.message, 500);
  }
  result = checked.data;

  const responseStatus = method.responseMeta?.status ?? (method.outputSchema ? 200 : 204);
  if (method.outputSchema && (responseStatus === 204 || responseStatus === 205)) {
    throw new AppError(
      'INTERNAL_SERVER_ERROR',
      `${method.serviceName}.${method.key} cannot combine output with bodyless status ${responseStatus}`,
      500,
    );
  }
  const responseHeaders = new Headers(requestCorsHeaders(cors, req));
  applyResponseMetadata(
    responseHeaders,
    responseMetadata,
    `${method.serviceName}.${method.key}`,
  );

  // The line is written only once the response exists. `json()` throws on
  // data `Response.json` cannot serialise (a `BigInt`, a cycle), and that
  // throw belongs to the error path — logging `200` first would record a
  // success the caller never received.
  if (!method.outputSchema) {
    const empty = new Response(null, { status: responseStatus, headers: responseHeaders });
    request.complete(responseStatus);
    return empty;
  }

  const body = Response.json(result, { status: responseStatus, headers: responseHeaders });
  request.complete(responseStatus);
  return body;
}
