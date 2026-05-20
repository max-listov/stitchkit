/**
 * `RuntimeContext` assembly — parses params / body / multipart against the
 * endpoint schemas and gathers request metadata (trace id, client info).
 */
import { badRequest, type RuntimeContext } from '../contract';
import { isUnsafeKey, safeJsonParse } from '../internal/safe-json';
import { parseMultipart } from './multipart';
import { type ClientIpOptions, getClientInfo, parseQueryParams } from './request';
import type { MethodDef } from './types';

/** Context keys the router owns — a path `:param` may never shadow them. */
const RESERVED_KEYS = new Set([
  'params',
  'input',
  'source',
  'req',
  'url',
  'headers',
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
async function readJsonBody(req: Request): Promise<unknown> {
  const text = await req.text();
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

export async function buildContext(
  req: Request,
  url: URL,
  method: MethodDef,
  pathParams: Record<string, string>,
  traceId: string,
  clientIp: ClientIpOptions,
): Promise<RuntimeContext> {
  const parsedParams = method.paramsSchema ? method.paramsSchema.parse(pathParams) : undefined;

  let parsedInput: unknown;
  let file: File | undefined;
  if (method.multipart) {
    const multipart = await parseMultipart(req, method.multipart, method.inputSchema);
    parsedInput = multipart.fields;
    file = multipart.file;
  } else if (method.inputSchema) {
    if (req.method === 'GET') {
      parsedInput = method.inputSchema.parse(parseQueryParams(url));
    } else if (req.method === 'DELETE') {
      const ct = req.headers.get('content-type');
      if (ct?.includes('application/json')) {
        parsedInput = method.inputSchema.parse(await readJsonBody(req));
      } else {
        parsedInput = method.inputSchema.parse(parseQueryParams(url));
      }
    } else {
      parsedInput = method.inputSchema.parse(await readJsonBody(req));
    }
  }

  const safePathParams: Record<string, string> = {};
  for (const [k, v] of Object.entries(pathParams)) {
    // Skip both router-owned keys and prototype-pollution keys — a `:param`
    // named `__proto__` must never reach the spread into `RuntimeContext`.
    if (!RESERVED_KEYS.has(k) && !isUnsafeKey(k)) safePathParams[k] = v;
  }

  return {
    params: parsedParams,
    input: parsedInput,
    ...(file && { file }),
    source: 'http',
    req,
    url,
    headers: req.headers,
    ...safePathParams,
    traceId,
    ...getClientInfo(req, clientIp),
  };
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
