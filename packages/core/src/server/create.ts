/**
 * HTTP handler — the request pipeline. Route matching lives in `router.ts`,
 * context assembly in `context.ts`, request helpers in `request.ts`.
 */
import { AppError, type RuntimeContext } from '../contract';
import { normalizeError } from '../internal/errors';
import { buildContext, buildErrorContext } from './context';
import {
  buildLogFields,
  elapsedMs,
  levelForStatus,
  logIncoming,
  logOutgoing,
  type RequestLog,
  shouldLog,
} from './logger';
import { corsHeaders as buildCorsHeaders, corsPreflightResponse } from './middleware/cors';
import { extractIp, resolveTraceId } from './request';
import {
  allowedMethods,
  buildRouteMap,
  matchRawRoute,
  matchRoute,
  type NormalizedGroup,
  validateRoutes,
} from './router';
import type { BunServer, MethodDef, ServerConfig, StitchLogger } from './types';

export function createHandler(config: ServerConfig): (req: Request) => Promise<Response> {
  const { cors, hooks, logging = false } = config;

  const customLogger: StitchLogger | null = typeof logging === 'object' ? logging : null;
  const useDefaultLog = logging === true;
  const resolveId = config.traceId ?? resolveTraceId;

  const routeMap = buildRouteMap(normalizeGroups(config));
  validateRoutes(routeMap);

  async function dispatch(
    req: Request,
    url: URL,
    traceId: string,
    server: BunServer | undefined,
  ): Promise<Response> {
    const shouldLogRequest = logging && shouldLog(url.pathname, req.method);

    let reqLog: RequestLog | undefined;
    if (shouldLogRequest && useDefaultLog) {
      reqLog = logIncoming(req, url.pathname, traceId);
    }
    if (shouldLogRequest && customLogger) {
      customLogger.debug(`${req.method} ${url.pathname}`, {
        traceId,
        method: req.method,
        path: url.pathname,
        ip: extractIp(req) || undefined,
      });
      reqLog = { traceId, startTime: process.hrtime.bigint() };
    }

    const logDone = (status: number) => {
      if (!reqLog) return;
      if (useDefaultLog) logOutgoing(req, url.pathname, status, reqLog);
      if (customLogger) {
        const durationMs = Math.round(elapsedMs(reqLog.startTime));
        const level = levelForStatus(status);
        customLogger[level](
          `${req.method} ${url.pathname} ${status} ${durationMs}ms`,
          buildLogFields(req.method, url.pathname, status, durationMs, reqLog.traceId),
        );
      }
    };

    // One error path — `onError` first (same envelope as the project chooses),
    // else the framework default. Used by raw routes, contract routes and the
    // unmatched-route 404 alike, so every error response has one shape.
    const respondError = async (
      err: unknown,
      errCtx?: RuntimeContext,
      endpoint?: MethodDef,
    ): Promise<Response> => {
      if (hooks?.onError) {
        try {
          const response = await hooks.onError(
            errCtx ?? buildErrorContext(req, url, traceId),
            err,
            endpoint,
          );
          if (response instanceof Response) {
            const withCors = applyCors(response, cors, req);
            logDone(withCors.status);
            return withCors;
          }
        } catch {
          // `onError` itself failed — fall through to the framework default
          // so a broken error hook can never crash the request.
        }
      }
      const appErr = normalizeError(err);
      logDone(appErr.status);
      return json(appErr.toJSON(), appErr.status, cors, req);
    };

    if (cors && req.method === 'OPTIONS') {
      const res = corsPreflightResponse(cors, req);
      logDone(204);
      return res;
    }

    if (hooks?.onRequest) {
      const earlyResponse = await hooks.onRequest(req);
      if (earlyResponse instanceof Response) {
        logDone(earlyResponse.status);
        return earlyResponse;
      }
    }

    // Raw (non-contract) routes — matched before contracts, take precedence.
    // The handler is fully in control: no schema parsing, no auth gate.
    // Matched `:param` values are passed to the handler; thrown errors run
    // through `hooks.onError` — same error shape as contract endpoints.
    if (config.rawRoutes) {
      const rawMatch = matchRawRoute(config.rawRoutes, req.method, url.pathname);
      if (rawMatch) {
        try {
          const res = await rawMatch.route.handler(req, {
            params: rawMatch.params,
            server,
          });
          const withCors = applyCors(res, cors, req);
          logDone(withCors.status);
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

    const { method, pathParams, groupHooks } = match;
    let ctx: RuntimeContext | undefined;

    try {
      ctx = await buildContext(req, url, method, pathParams, traceId);

      if (hooks?.beforeHandle) {
        await hooks.beforeHandle(ctx, method);
      }
      if (groupHooks?.beforeHandle) {
        await groupHooks.beforeHandle(ctx, method);
      }

      let result = await method.handler(ctx);

      if (groupHooks?.afterHandle) {
        const transformed = await groupHooks.afterHandle(ctx, result, method);
        if (transformed !== undefined) result = transformed;
      }
      if (hooks?.afterHandle) {
        const transformed = await hooks.afterHandle(ctx, result, method);
        if (transformed !== undefined) result = transformed;
      }

      if (method.outputSchema) {
        result = method.outputSchema.parse(result);
      }

      if (result === undefined || result === null) {
        logDone(204);
        return new Response(null, { status: 204, headers: corsHeaders(cors, req) });
      }

      logDone(200);
      return json(result, 200, cors, req);
    } catch (err) {
      return respondError(err, ctx, method);
    }
  }

  return async (req: Request, server?: BunServer): Promise<Response> => {
    const url = new URL(req.url);
    const traceId = resolveId(req);
    const response = await dispatch(req, url, traceId, server);
    // Every response carries the trace id — success and error alike.
    if (!response.headers.has('x-request-id')) {
      response.headers.set('x-request-id', traceId);
    }
    return response;
  };
}

export function createServer(config: ServerConfig) {
  const { routes, websocket, development, bun: bunExtra, port = 3000, hostname } = config;

  const fetch = createHandler(config);

  return websocket
    ? Bun.serve({
        ...bunExtra,
        ...(routes && { routes }),
        ...(development && { development }),
        port,
        hostname,
        websocket,
        fetch,
      })
    : Bun.serve({
        ...bunExtra,
        ...(development && { development }),
        port,
        hostname,
        fetch,
      });
}

// ─── Group normalization ─────────────────────────────

function normalizeGroups(config: ServerConfig): NormalizedGroup[] {
  const result: NormalizedGroup[] = [];

  if (config.services) {
    for (const service of config.services) {
      result.push({ prefix: '', service });
    }
  }

  if (config.groups) {
    for (const group of config.groups) {
      for (const service of group.services) {
        result.push({ prefix: group.pathPrefix ?? '', service, hooks: group.hooks });
      }
    }
  }

  return result;
}

// ─── Response helpers ────────────────────────────────

function corsHeaders(cors: ServerConfig['cors'], req: Request): Record<string, string> {
  if (!cors) return {};
  return buildCorsHeaders(cors, req.headers.get('origin'));
}

/**
 * Apply CORS headers to a response produced outside the framework (a raw route
 * or an `onError` hook). The response is rebuilt rather than mutated — a
 * `Response.redirect()` (a documented raw-route use) has immutable headers.
 */
function applyCors(res: Response, cors: ServerConfig['cors'], req: Request): Response {
  const extra = corsHeaders(cors, req);
  if (Object.keys(extra).length === 0) return res;
  const headers = new Headers(res.headers);
  for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

function json(
  data: unknown,
  status: number,
  cors: ServerConfig['cors'],
  req: Request,
): Response {
  return Response.json(data, { status, headers: corsHeaders(cors, req) });
}
