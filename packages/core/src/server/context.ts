/**
 * `RuntimeContext` assembly — parses params / body / multipart against the
 * endpoint schemas and gathers request metadata (trace id, client info).
 */
import { badRequest, type RuntimeContext } from '../contract';
import { isUnsafeKey, safeJsonParse } from '../internal/safe-json';
import { type MultipartLifecycle, parseMultipart } from './multipart';
import { type ClientIpOptions, getClientInfo, parseQueryParams } from './request';
import { readRequestText } from './request-body';
import type { AuthorizationContext, MethodDef } from './types';

/** Context keys the router owns — a path `:param` may never shadow them. */
const RESERVED_KEYS = new Set([
  'params',
  'input',
  'source',
  'req',
  'url',
  'headers',
  'rawBody',
  'traceId',
  'spanId',
  'ipAddress',
  'userAgent',
]);

/**
 * Parse a JSON request body — an empty body is `{}`, a malformed body a 400.
 * A non-empty body must declare `Content-Type: application/json`: a
 * `text/plain` body is a simple cross-origin request a form can forge, so
 * rejecting it keeps CSRF off cookie-authenticated endpoints.
 */
function parseJsonBody(req: Request, text: string): unknown {
  if (text.trim() === '') return {};
  if (!req.headers.get('content-type')?.includes('application/json')) {
    badRequest('Request body must be application/json');
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
    if (!RESERVED_KEYS.has(k) && !isUnsafeKey(k)) safePathParams[k] = v;
  }

  return {
    params: pathParams,
    input: undefined,
    source: 'http',
    req,
    url,
    headers: req.headers,
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
      const ct = req.headers.get('content-type');
      if (ct?.includes('application/json')) {
        const text = await readRequestText(req, method.maxJsonBodyBytes ?? maxJsonBodyBytes);
        if (method.rawBody) ctx.rawBody = text;
        ctx.input = method.inputSchema.parse(parseJsonBody(req, text));
      } else {
        ctx.input = method.inputSchema.parse(parseQueryParams(url));
      }
    } else {
      const text = await readRequestText(req, method.maxJsonBodyBytes ?? maxJsonBodyBytes);
      if (method.rawBody) ctx.rawBody = text;
      ctx.input = method.inputSchema.parse(parseJsonBody(req, text));
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
    traceId,
    ...getClientInfo(req, clientIp),
  };
}
