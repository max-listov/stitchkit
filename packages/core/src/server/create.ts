/**
 * HTTP handler — the request pipeline. Route matching lives in `router.ts`,
 * context assembly in `context.ts`, request helpers in `request.ts`.
 */
import { AppError, type RuntimeContext } from '../contract';
import {
  errorCode,
  normalizeError,
  recordedErrorMessage,
  validateDeclaredOutput,
} from '../internal/errors';
import {
  getRequestContext,
  runWithRequestContext,
  setRequestEndpoint,
  setRequestError,
} from '../observability/context';
import { resolveTraceContext } from '../observability/trace';
import { buildBaseContext, buildErrorContext, parseRequestInto } from './context';
import {
  buildLogFields,
  levelForStatus,
  logIncoming,
  logOutgoing,
  type RequestLog,
  resolveLogFormat,
  shouldLog,
} from './logger';
import { collectExtraLogFields, resolveLoggingConfig, shouldSkipLog } from './logging';
import {
  assertCorsConfig,
  corsHeaders as buildCorsHeaders,
  corsPreflightResponse,
} from './middleware/cors';
import { type ClientIpOptions, extractIp, resolveSocketIp, resolveTraceId } from './request';
import { assertJsonBodyLimit } from './request-body';
import { applyResponseMetadata, createResponseMetadata } from './response-metadata';
import {
  allowedMethods,
  buildRouteMap,
  findShadowedRoutes,
  matchRawRoute,
  matchRoute,
  type NormalizedGroup,
  validateRawRoutes,
  validateRoutes,
} from './router';
import type { FetchHandler, HandlerConfig, MethodDef, StitchLogger } from './types';

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function createHandler<TServer = unknown>(
  config: HandlerConfig<TServer>,
): FetchHandler<TServer> {
  const { cors, hooks, logging = false, observability, trustProxy = false } = config;
  if (cors) assertCorsConfig(cors);
  assertJsonBodyLimit(config.maxJsonBodyBytes, 'HandlerConfig.maxJsonBodyBytes');

  // `true` is shorthand for `{}`: any object turns logging on, and `logger`
  // decides which sink writes it. Throws on a pre-0.28 bare `StitchLogger`.
  const logConfig = resolveLoggingConfig(logging);
  const customLogger: StitchLogger | null = logConfig?.logger ?? null;
  const useDefaultLog = logConfig !== null && !logConfig.logger;
  const customTraceId = config.traceId;

  /**
   * Report a framework-level problem through the configured sink. Guarded: a
   * broken logger must never surface as the outcome of the request it observes.
   */
  const warn = (line: string): void => {
    try {
      if (customLogger) customLogger.warn(line);
      else console.warn(line);
    } catch {
      // A logger must never break the request it observes.
    }
  };

  /**
   * The request's trace id. A custom resolver is consumer code called before
   * any error handling exists, so it is contained here: `undefined` and a throw
   * both fall back to the framework resolver rather than costing the response.
   * The throw is reported once per handler — silence would lose every
   * correlation id without a word, and one line per request would be noise.
   */
  let traceResolverBroken = false;
  const warnedEnrichKeys = new Set<string>();
  const resolveId = (req: Request, fallback?: string): string => {
    if (!customTraceId) return fallback ?? resolveTraceId(req);
    try {
      return customTraceId(req) ?? fallback ?? resolveTraceId(req);
    } catch (err) {
      if (!traceResolverBroken) {
        traceResolverBroken = true;
        warn(
          '[stitchkit] `traceId` resolver threw — falling back to the framework resolver. ' +
            'Ids will not match your observability context until it is fixed: ' +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return fallback ?? resolveTraceId(req);
    }
  };

  const routeMap = buildRouteMap(normalizeGroups(config));
  validateRoutes(routeMap);
  validateRawRoutes(config.rawRoutes);

  // Raw routes match first, so one covering a contract path makes that endpoint
  // dead — and takes its auth gate with it. Reported at startup because the
  // silent version of this is the failure raw-response endpoints exist to
  // prevent: move a download into the contract for the gate, forget the old raw
  // route, keep serving the bytes ungated. → ADR 0038.
  for (const shadow of findShadowedRoutes(routeMap, config.rawRoutes)) {
    const gate = shadow.scope && shadow.scope !== 'public' ? ` (scope "${shadow.scope}")` : '';
    const line =
      `[stitchkit] raw route ${shadow.rawRoute} shadows contract route ${shadow.pattern}` +
      ` → ${shadow.endpoint}${gate} will never run, and its hooks never apply`;
    warn(line);
  }

  async function dispatch(
    req: Request,
    url: URL,
    traceId: string,
    server: TServer | undefined,
    clientIp: ClientIpOptions,
    startedAt: bigint,
  ): Promise<Response> {
    const shouldLogRequest =
      logConfig !== null &&
      shouldLog(url.pathname, req.method) &&
      !shouldSkipLog(logConfig, req, url);
    const ipAddress = extractIp(req, clientIp) || undefined;
    const payload =
      observability?.includePayload && BODY_METHODS.has(req.method)
        ? req
            .clone()
            .json()
            .catch(() => undefined)
        : undefined;

    // Resolved once per request, not at import and not at this package's build:
    // the environment that decides the format is the consumer's, at run time.
    const logFormat = resolveLogFormat(logConfig?.format);

    let reqLog: RequestLog | undefined;
    if (shouldLogRequest && useDefaultLog) {
      reqLog = logIncoming(req, url.pathname, traceId, logFormat, ipAddress);
    }
    if (shouldLogRequest && customLogger) {
      // The timing window opens regardless: a breadcrumb that fails must cost
      // the breadcrumb, not the completion line — and never the request.
      reqLog = { traceId };
      try {
        customLogger.debug(`${req.method} ${url.pathname}`, {
          traceId,
          method: req.method,
          path: url.pathname,
          ip: ipAddress,
        });
      } catch {
        // A logger must never break the request it observes.
      }
    }

    // At most one completion line per request, and a sink that throws can never
    // take the request with it. Both matter on the error path: `respondError`
    // calls this once for a hook-supplied response and once for the framework
    // default, and a throw in the first call would be swallowed by the
    // `onError` catch only to be re-thrown — uncaught — by the second.
    let completed = false;
    const complete = (status: number, errorCode?: string) => {
      if (completed) return;
      completed = true;
      const durationMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);

      if (reqLog && logConfig) {
        try {
          const collected = collectExtraLogFields(logConfig, req, url, {
            status,
            durationMs,
            errorCode,
          });
          const frameworkFields = buildLogFields(
            req.method,
            url.pathname,
            status,
            durationMs,
            reqLog.traceId,
            errorCode,
          );
          const ownedFields = { ...frameworkFields, ip: ipAddress };
          for (const key of collected.enrichKeys) {
            const ownedByActiveSink =
              Object.hasOwn(ownedFields, key) ||
              (useDefaultLog && (key === 'ts' || key === 'level' || key === 'msg'));
            if (ownedByActiveSink && !warnedEnrichKeys.has(key)) {
              warnedEnrichKeys.add(key);
              warn(
                `[stitchkit] logging.enrich field "${key}" was discarded because the framework owns it`,
              );
            }
          }
          const extra = collected.fields;
          if (useDefaultLog) {
            logOutgoing({
              req,
              pathname: url.pathname,
              status,
              log: reqLog,
              ipAddress,
              errorCode,
              durationMs,
              format: logFormat,
              extra,
            });
          }
          if (customLogger) {
            const level = levelForStatus(status);
            customLogger[level](
              `${req.method} ${url.pathname} ${status}${errorCode ? ` ${errorCode}` : ''} ${durationMs}ms`,
              {
                ...extra,
                ...frameworkFields,
                // Written last for the same reason as the rest, and present here
                // as well as on the built-in line so both sinks carry one shape.
                ip: ipAddress,
              },
            );
          }
        } catch {
          // A logger must never break the request it observes.
        }
      }

      const context = getRequestContext();
      if (observability && context) {
        try {
          observability.complete({ context, statusCode: status, durationMs, payload });
        } catch {
          // An observability projection must never break the request it observes.
        }
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
      // Record the failure on the request context so an audit row can name it
      // without the project hand-wiring `setRequestError` — the same thing the
      // tool row does for itself. Written after `onError` has had its turn and
      // only when nothing is there: a project that curates its own value wins,
      // a project that wires nothing still gets a row. → ADR 0042.
      //
      // `AppError.is` and `errorCode` are side-effect-free; `normalizeError` is
      // not — it logs the raw cause — so the custom-`onError` branch passes
      // nothing and must never reach for it, or customising the envelope would
      // start writing a stderr line that was not there before.
      const recordFailure = (normalized?: AppError): void => {
        if (getRequestContext()?.error !== undefined) return;
        const known = AppError.is(err) ? err : normalized;
        const code = known?.code ?? errorCode(err) ?? 'INTERNAL_SERVER_ERROR';
        setRequestError({
          code,
          message: recordedErrorMessage(code, known?.message, err),
          details: known?.details,
        });
      };

      if (hooks?.onError) {
        try {
          const response = await hooks.onError(
            errCtx ?? buildErrorContext(req, url, traceId, clientIp),
            err,
            endpoint,
          );
          if (response instanceof Response) {
            recordFailure();
            const withCors = applyCors(response, cors, req);
            // The hook owns the response, but the access log still wants the
            // error's code — derive it from the original error (no normalize /
            // no log), so `logging: true` shows it even with a custom `onError`.
            complete(withCors.status, errorCode(err));
            return withCors;
          }
        } catch {
          // `onError` itself failed — fall through to the framework default
          // so a broken error hook can never crash the request.
        }
      }
      const appErr = normalizeError(err);
      recordFailure(appErr);
      complete(appErr.status, appErr.code);
      return json(appErr.toJSON(), appErr.status, cors, req);
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

    const { method, pathParams, groupHooks } = match;
    // The base context is everything knowable from the URL alone — bound before
    // any schema parsing, so a validation failure still gives `onError` the path
    // params and the request instead of an empty context.
    const ctx = buildBaseContext(req, url, pathParams, traceId, clientIp);
    // Surface the matched operation's stable identity into the request context
    // before validation — a no-op without an active observability context, so an
    // audit event is attributed to its `(service, action)` even on a 400. → ADR 0022 / 0029.
    setRequestEndpoint(method.serviceName, method.key);

    try {
      await parseRequestInto(
        ctx,
        req,
        url,
        method,
        config.maxUploadBytes,
        config.maxJsonBodyBytes,
      );

      if (hooks?.beforeHandle) {
        await hooks.beforeHandle(ctx, method);
      }
      if (groupHooks?.beforeHandle) {
        await groupHooks.beforeHandle(ctx, method);
      }

      const responseMetadata = method.responseMeta ? createResponseMetadata() : undefined;
      if (responseMetadata) ctx.response = responseMetadata;

      let result = await method.handler(ctx);

      // A raw endpoint owns its response: no `afterHandle` (that hook
      // transforms *data*, and there is none), no output validation, no
      // serialization. Only CORS is applied — in place, so a `206` keeps its
      // body intact. Everything before this point ran normally, which is the
      // whole point: the auth gate, params and input validation are the same
      // as for any endpoint. → ADR 0038.
      if (method.rawResponse) {
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
        const rawRes = applyCors(response, cors, req);
        complete(rawRes.status);
        return rawRes;
      }

      if (groupHooks?.afterHandle) {
        const transformed = await groupHooks.afterHandle(ctx, result, method);
        if (transformed !== undefined) result = transformed;
      }
      if (hooks?.afterHandle) {
        const transformed = await hooks.afterHandle(ctx, result, method);
        if (transformed !== undefined) result = transformed;
      }

      // The mirror image of the branch above, and the reason this endpoint kind
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
      const responseHeaders = new Headers(corsHeaders(cors, req));
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
        complete(responseStatus);
        return empty;
      }

      const body = Response.json(result, { status: responseStatus, headers: responseHeaders });
      complete(responseStatus);
      return body;
    } catch (err) {
      return respondError(err, ctx, method);
    }
  }

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
      const response = await dispatch(req, url, traceId, server, clientIp, startedAt);
      // Every response carries the framework-resolved trace id — always
      // overwritten, never the value a raw route or `onError` may have echoed
      // from the client. Immutable headers (a `Response.redirect()`) are
      // tolerated: the id is best-effort there.
      try {
        response.headers.set('x-request-id', traceId);
      } catch {
        // headers are immutable — a redirect / opaque response; skip.
      }
      return response;
    };

    const activeContext = getRequestContext();
    if (activeContext) {
      return run(activeContext.trace.traceId, activeContext.startedAt);
    }

    if (!observability) return run(resolveId(req), requestStartedAt);

    const trace = resolveTraceContext(req);
    const traceId = resolveId(req, trace.traceId);
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

// ─── Group normalization ─────────────────────────────

function normalizeGroups<TServer>(config: HandlerConfig<TServer>): NormalizedGroup[] {
  const result: NormalizedGroup[] = [];

  if (config.services) {
    for (const service of config.services) {
      // `scope → prefix` mapping: a scoped service mounts under its prefix, an
      // unmapped one mounts flat. Explicit `groups` below are unaffected.
      const prefix = config.scopePrefixes?.[service.scope] ?? '';
      result.push({ prefix, service });
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

function corsHeaders(cors: HandlerConfig['cors'], req: Request): Record<string, string> {
  if (!cors) return {};
  return buildCorsHeaders(cors, req.headers.get('origin'));
}

/**
 * Apply CORS headers to a response produced outside the framework (a raw route,
 * a binary endpoint or an `onError` hook).
 *
 * Headers are mutated **in place**. Rebuilding with `new Response(res.body, …)`
 * silently corrupts partial responses: on Bun, reading `.body` of a response
 * built from `Bun.file().slice()` re-reads the *whole* file, so a `206` keeps
 * its honest `Content-Range` and `Content-Length` while the payload becomes the
 * entire file — a client stitching ranges gets garbage.
 *
 * A rebuild survives only as the fallback: WHATWG marks `Response.redirect()`
 * headers immutable (Node throws; Bun currently allows the set), and a redirect
 * has no body to corrupt.
 */
function applyCors(res: Response, cors: HandlerConfig['cors'], req: Request): Response {
  const extra = corsHeaders(cors, req);
  if (Object.keys(extra).length === 0) return res;
  try {
    for (const [key, value] of Object.entries(extra)) setCorsHeader(res.headers, key, value);
    return res;
  } catch {
    const headers = new Headers(res.headers);
    for (const [key, value] of Object.entries(extra)) setCorsHeader(headers, key, value);
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  }
}

/**
 * `Vary` is a list the handler may already contribute to (a file response
 * carrying `Vary: Accept-Encoding`); overwriting it with `Origin` would make a
 * shared cache serve one encoding to everyone. Every other CORS header is
 * single-valued and ours alone, so it is set.
 */
function setCorsHeader(headers: Headers, key: string, value: string): void {
  if (key !== 'Vary') {
    headers.set(key, value);
    return;
  }
  const existing = headers.get('Vary');
  if (existing === null || existing.trim() === '') {
    headers.set('Vary', value);
    return;
  }
  const present = existing.split(',').some((field) => field.trim().toLowerCase() === 'origin');
  if (!present) headers.set('Vary', `${existing}, ${value}`);
}

function json(
  data: unknown,
  status: number,
  cors: HandlerConfig['cors'],
  req: Request,
): Response {
  return Response.json(data, { status, headers: corsHeaders(cors, req) });
}
