/**
 * HTTP handler — the request pipeline, one module per phase:
 * `handler-state.ts` (what the handler resolves once), `route-table.ts` and
 * `router.ts` (the route table and matching), `request-completion.ts` (the
 * log/observability window), `error-dispatch.ts` (the error path),
 * `endpoint-dispatch.ts` and `endpoint-response.ts` (a matched contract
 * endpoint). Context assembly lives in `context.ts`.
 */

import { AppError } from '../contract/errors';
import { type ClientIpOptions, extractIp, resolveSocketIp } from '../internal/request';
import {
  getRequestContext,
  runWithRequestContext,
  setRequestEndpoint,
} from '../observability/context';
import { resolveTraceContext } from '../observability/trace';
import { RELEASE_HEADER } from '../release/header';
import { dispatchEndpoint } from './endpoint-dispatch';
import { createErrorResponder } from './error-dispatch';
import { createHandlerState, type HandlerState, type RequestState } from './handler-state';
import { applyCors, corsPreflightResponse } from './middleware/cors';
import { openRequestCompletion } from './request-completion';
import { allowedMethods, matchRawRoute, matchRoute } from './router';
import type { FetchHandler, HandlerConfig } from './types';

export function createHandler<TServer = unknown>(
  config: HandlerConfig<TServer>,
): FetchHandler<TServer> {
  const { trustProxy = false, observability } = config;
  const state = createHandlerState(config);

  return async (req: Request, server?: TServer): Promise<Response> => {
    // `req.url` is an absolute URL on Bun/Deno/srvx, but Node adapters may
    // pass just the pathname — the base avoids a `TypeError: Invalid URL`.
    const url = new URL(req.url, 'http://localhost');
    const requestStartedAt = process.hrtime.bigint();
    // Resolve the real socket peer once per request — the adapter (Bun server
    // / srvx) knows it; `extractIp` prefers `x-forwarded-for` over it only
    // when `trustProxy` is set.
    const clientIp: ClientIpOptions = {
      trustProxy,
      socketIp: resolveSocketIp(req, server),
    };
    const run = async (traceId: string, startedAt: bigint): Promise<Response> => {
      const response = await dispatch(state, req, url, traceId, server, clientIp, startedAt);
      // Every response carries the framework-resolved trace id — always
      // overwritten, never the value a raw route or `onError` may have echoed
      // from the client. Immutable headers (a `Response.redirect()`) are
      // tolerated: the id is best-effort there.
      try {
        response.headers.set('x-request-id', traceId);
        // The build the server considers current, beside the trace id, on
        // every response — the channel a client has without a socket.
        const buildId = config.release?.current();
        if (buildId) response.headers.set(RELEASE_HEADER, buildId);
      } catch {
        // headers are immutable — a redirect / opaque response; skip.
      }
      return response;
    };

    const activeContext = getRequestContext();
    if (activeContext) {
      return run(activeContext.trace.traceId, activeContext.startedAt);
    }

    if (!observability) return run(state.resolveId(req), requestStartedAt);

    const trace = resolveTraceContext(req);
    const traceId = state.resolveId(req, trace.traceId);
    const ipAddress = extractIp(req, clientIp) || undefined;
    const userAgent = req.headers.get('user-agent') ?? undefined;
    return runWithRequestContext(
      {
        source: 'http',
        method: req.method,
        path: url.pathname,
        startedAt: requestStartedAt,
        trace: { ...trace, traceId },
        ...(ipAddress !== undefined && { ipAddress }),
        ...(userAgent !== undefined && { userAgent }),
      },
      () => run(traceId, requestStartedAt),
    );
  };
}

async function dispatch<TServer>(
  state: HandlerState<TServer>,
  req: Request,
  url: URL,
  traceId: string,
  server: TServer | undefined,
  clientIp: ClientIpOptions,
  startedAt: bigint,
): Promise<Response> {
  const { cors, hooks, config, routeMap } = state;
  const ipAddress = extractIp(req, clientIp) || undefined;
  const complete = openRequestCompletion(state, { req, url, traceId, startedAt, ipAddress });
  const respondError = createErrorResponder(state, { req, url, traceId, clientIp, complete });
  const request: RequestState<TServer> = {
    req,
    url,
    traceId,
    server,
    clientIp,
    ipAddress,
    complete,
    respondError,
  };

  if (cors && req.method === 'OPTIONS') {
    // No completion line: `shouldLog` drops `OPTIONS` before the timing
    // window opens, so a preflight has nothing to close.
    const response = corsPreflightResponse(cors, req);
    complete(response.status);
    return response;
  }

  // `onRequest` is consumer code, so a throw takes the same path as any other
  // failure — `onError`, the project's envelope, CORS, one log line — instead
  // of escaping `dispatch` for the runtime to answer bare.
  try {
    if (hooks?.onRequest) {
      const earlyResponse = await hooks.onRequest(req);
      if (earlyResponse instanceof Response) {
        // Apply CORS like every other exit — an `onRequest` short-circuit (an
        // auth wall, a maintenance page) answered to a browser must still
        // carry `Access-Control-Allow-Origin`, or the response is unreadable
        // cross-origin.
        const withCors = applyCors(earlyResponse, cors, req);
        complete(withCors.status);
        return withCors;
      }
    }
  } catch (err) {
    return respondError(err);
  }

  // Raw (non-contract) routes — matched before contracts, take precedence.
  // The handler is fully in control: no schema parsing, no auth gate.
  // Matched `:param` values are passed to the handler; thrown errors run
  // through `hooks.onError` — same error shape as contract endpoints.
  if (config.rawRoutes) {
    const rawMatch = matchRawRoute(config.rawRoutes, req.method, url.pathname);
    if (rawMatch) {
      if (rawMatch.route.serviceName !== undefined) {
        setRequestEndpoint(rawMatch.route.serviceName, rawMatch.route.action);
      }
      try {
        const res = await rawMatch.route.handler(req, {
          params: rawMatch.params,
          server,
          ipAddress,
        });
        const withCors = applyCors(res, cors, req);
        complete(withCors.status);
        return withCors;
      } catch (err) {
        return respondError(err);
      }
    }
  }

  const match = matchRoute(routeMap, req.method, url.pathname);
  if (!match) {
    // No route under this method: `405` if the path exists under another
    // method, else `404`. Both run through `onError` — one error envelope.
    const allow = allowedMethods(routeMap, url.pathname);
    if (allow.length > 0) {
      const res = await respondError(
        new AppError('METHOD_NOT_ALLOWED', `Method ${req.method} not allowed`, 405),
      );
      res.headers.set('Allow', allow.join(', '));
      return res;
    }
    return respondError(new AppError('NOT_FOUND', 'Not found', 404));
  }

  return dispatchEndpoint(state, request, match);
}
