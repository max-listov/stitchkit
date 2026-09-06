/**
 * `RuntimeContext` assembly — parses params / body / multipart against the
 * endpoint schemas and gathers request metadata (trace id, client info).
 */
import { badRequest, forbidden, type RuntimeContext } from '../contract';
import { mediaTypeEssence } from '../internal/media-type';
import { isUnsafeKey, safeJsonParse } from '../internal/safe-json';
import { RUNTIME_CONTEXT_RESERVED_KEYS } from './context-contribution';
import { type CorsConfig, isOriginAllowed } from './middleware/cors';
import { type MultipartLifecycle, parseMultipart } from './multipart';
import { type ClientIpOptions, getClientInfo, parseQueryParams } from './request';
import { readRequestText } from './request-body';
import type { AuthorizationContext, MethodDef } from './types';

/**
 * Parse a JSON request body — an empty body is `{}`, a malformed body a 400.
 * A non-empty body must declare `Content-Type: application/json`: a
 * `text/plain` body is a simple cross-origin request a form can forge, so
 * rejecting it keeps CSRF off cookie-authenticated endpoints.
 *
 * An endpoint that declared `safelistedBody` accepts the same JSON under
 * `text/plain` — but only from an `Origin` on the explicit CORS allow-list.
 * The browser sends that header on every cross-origin `POST` and on
 * `sendBeacon`, and it is the one thing a foreign page cannot choose; a
 * request without it, with `null`, or from a site the server never named is
 * refused before the text is parsed. → ADR 0165.
 */
function parseJsonBody(
  req: Request,
  text: string,
  method: MethodDef,
  cors: CorsConfig | undefined,
): unknown {
  if (text.trim() === '') return {};
  const essence = mediaTypeEssence(req.headers.get('content-type'));
  if (essence !== 'application/json') {
    if (!method.safelistedBody || essence !== 'text/plain') {
      badRequest('Request body must be application/json');
    }
    const origin = req.headers.get('origin');
    if (!cors || cors.origin === undefined || cors.origin === '*') {
      forbidden('A text/plain body requires an explicit cors.origin allow-list on the server');
    }
    if (!origin) forbidden('A text/plain body requires an Origin header');
    if (!isOriginAllowed(cors, origin)) {
      forbidden('A text/plain body is accepted only from an allowed origin');
    }
  }
  try {
    return safeJsonParse(text);
  } catch {
    badRequest('Invalid JSON body');
  }
}

/**
 * Assemble everything knowable from the URL alone — path params, the request,
 * trace id and client info — **before** any schema parsing. Bound first so a
 * later validation failure still hands `onError` the path params and the
 * request (an empty context loses both); the two parsing phases then enrich it
 * with schema-validated params and payload.
 *
 * `params` starts as the raw matched path params (a property of the URL, known
 * the moment the route matched) and is replaced by the validated value when the
 * endpoint declares a `paramsSchema`.
 */
export function buildBaseContext(
  req: Request,
  url: URL,
  pathParams: Record<string, string>,
  traceId: string,
  clientIp: ClientIpOptions,
): AuthorizationContext {
  const safePathParams: Record<string, string> = {};
  for (const [k, v] of Object.entries(pathParams)) {
    // Skip both router-owned keys and prototype-pollution keys — a `:param`
    // named `__proto__` must never reach the spread into `RuntimeContext`.
    if (!RUNTIME_CONTEXT_RESERVED_KEYS.has(k) && !isUnsafeKey(k)) safePathParams[k] = v;
  }

  return {
    params: pathParams,
    input: undefined,
    source: 'http',
    req,
    url,
    headers: req.headers,
    signal: req.signal,
    ...safePathParams,
    traceId,
    ...getClientInfo(req, clientIp),
  };
}

/**
 * Parse `params` / `input` against the endpoint schemas and write them onto an
 * already-assembled base context. A validation failure throws a `ZodError`
 * here — the base context (path params, request) is preserved for `onError`.
 */
export function parsePathParamsInto(ctx: RuntimeContext, method: MethodDef): void {
  if (method.paramsSchema) {
    ctx.params = method.paramsSchema.parse(ctx.params);
  }
}

/** Parse query, JSON or multipart payload after pre-body authorization. */
export async function parseRequestPayloadInto(
  ctx: RuntimeContext,
  req: Request,
  url: URL,
  method: MethodDef,
  maxJsonBodyBytes?: number,
  cors?: CorsConfig,
): Promise<MultipartLifecycle | undefined> {
  if (method.multipart) {
    const multipart = await parseMultipart(
      req,
      method.multipart,
      method.inputSchema,
      method.multipartReceivers,
    );
    ctx.input = multipart.fields;
    ctx.files = multipart.files;
    return multipart;
  }
  if (method.inputSchema) {
    if (req.method === 'GET') {
      ctx.input = method.inputSchema.parse(parseQueryParams(url));
    } else if (req.method === 'DELETE') {
      if (mediaTypeEssence(req.headers.get('content-type')) === 'application/json') {
        const text = await readRequestText(req, method.maxJsonBodyBytes ?? maxJsonBodyBytes);
        if (method.rawBody) ctx.rawBody = text;
        ctx.input = method.inputSchema.parse(parseJsonBody(req, text, method, cors));
      } else {
        ctx.input = method.inputSchema.parse(parseQueryParams(url));
      }
    } else {
      const text = await readRequestText(req, method.maxJsonBodyBytes ?? maxJsonBodyBytes);
      if (method.rawBody) ctx.rawBody = text;
      ctx.input = method.inputSchema.parse(parseJsonBody(req, text, method, cors));
    }
  }
  return undefined;
}

export function buildErrorContext(
  req: Request,
  url: URL,
  traceId: string,
  clientIp: ClientIpOptions,
): RuntimeContext {
  return {
    params: undefined,
    input: undefined,
    source: 'http',
    req,
    url,
    headers: req.headers,
    signal: req.signal,
    traceId,
    ...getClientInfo(req, clientIp),
  };
}
