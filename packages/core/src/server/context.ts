/**
 * `RuntimeContext` assembly — parses params / body / multipart against the
 * endpoint schemas and gathers request metadata (trace id, client info).
 */
import { badRequest, type RuntimeContext } from '../contract';
import { parseMultipart } from './multipart';
import { getClientInfo, parseQueryParams } from './request';
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

/** Parse a JSON request body — an empty body is `{}`, a malformed body a 400. */
async function readJsonBody(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
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
    if (!RESERVED_KEYS.has(k)) safePathParams[k] = v;
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
    ...getClientInfo(req),
  };
}

export function buildErrorContext(req: Request, url: URL, traceId: string): RuntimeContext {
  return {
    params: undefined,
    input: undefined,
    source: 'http',
    req,
    url,
    headers: req.headers,
    traceId,
    ...getClientInfo(req),
  };
}
