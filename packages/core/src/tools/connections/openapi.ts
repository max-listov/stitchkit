import { z } from 'zod';
import type { HttpMethod } from '../../contract';
import { isRecord } from '../../internal/typed';
import { defineRuntimeTool, type RuntimeToolDefinition } from '../runtime-tool';
import { ConnectionAuthorizationRequiredError, ConnectionRequestError } from './errors';
import { fetchConnection } from './http';
import {
  connectionMaxResponseBytes,
  connectionTimeoutMs,
  readBoundedJson,
  readBoundedText,
  withConnectionDeadline,
} from './limits';
import { assertOpenApiOperation, resolveOpenApiDocument } from './openapi-document';
import { sanitizeToolName, withConnectionToken, zodObjectFromJsonSchema } from './runtime';
import { jsonSchemaBytes, recordForeignSchemaBytes } from './schema-budget';
import { assertAllowedHost, assertConnectionUrl, connectionAllowedHosts } from './ssrf';
import type { OpenApiConnection } from './types';

/** One `path` × `method` operation, already flattened out of the document. */
interface OpenApiOperation {
  method: HttpMethod;
  path: string;
  operation: Record<string, unknown>;
  pathItem: Record<string, unknown>;
}

interface ResolvedOpenApiAuth {
  placement: 'header' | 'query' | 'cookie';
  name: string;
  scheme: 'bearer' | 'basic' | 'apikey';
}

/** Load and mount every operation of one OpenAPI document. */
export async function mountOpenApiConnection(
  connection: OpenApiConnection,
  instanceId: string,
): Promise<RuntimeToolDefinition[]> {
  const timeoutMs = connectionTimeoutMs(connection.timeoutMs);
  const maxResponseBytes = connectionMaxResponseBytes(connection.maxResponseBytes);
  const loaded = await loadOpenApiDocument(connection, timeoutMs, maxResponseBytes);
  const document = resolveOpenApiDocument(loaded.document);
  const baseUrl = resolveBaseUrl(connection, document, loaded.url);
  const baseHost = assertConnectionUrl(baseUrl, connection.name);
  const allowedHosts = connectionAllowedHosts(
    loaded.url && !connection.baseUrl ? new URL(loaded.url) : baseHost,
    loaded.url
      ? [...(connection.allowHosts ?? []), new URL(loaded.url).host]
      : connection.allowHosts,
  );
  assertAllowedHost(new URL(baseUrl), allowedHosts, connection.name);

  const operations = collectOperations(document);
  const names = new Set<string>();

  return operations.map((entry) => {
    assertOpenApiOperation(document, entry.operation, entry.pathItem);
    const rawName = operationKey(entry);
    const name = uniqueToolName(connection.name, rawName, names);
    const description =
      typeof entry.operation.description === 'string'
        ? entry.operation.description
        : `${entry.method} ${entry.path}`;
    const schema = operationInputSchema(document, entry);
    const input = zodObjectFromJsonSchema(schema);
    const auth = resolveAuth(document, entry.operation);
    const definition = defineRuntimeTool({
      name,
      description,
      identity: {
        serviceName: connection.name,
        action: rawName,
        method: entry.method,
      },
      input,
      output: z.unknown(),
      handler: (context) =>
        withConnectionToken(
          { instanceId, provider: connection.token, context },
          async (token) => {
            const args = isRecord(context.input) ? context.input : {};
            const url = buildOperationUrl(baseUrl, entry, args);
            assertAllowedHost(url, allowedHosts, connection.name);
            const headers: Record<string, string> = { accept: 'application/json' };
            for (const parameter of operationParameters(document, entry)) {
              const value = args[parameter.name];
              if (value === undefined) continue;
              if (parameter.in === 'query')
                url.searchParams.set(parameter.name, String(value));
              else if (parameter.in === 'header') headers[parameter.name] = String(value);
              else if (parameter.in === 'cookie') {
                const cookie = `${parameter.name}=${encodeURIComponent(String(value))}`;
                headers.cookie = headers.cookie ? `${headers.cookie}; ${cookie}` : cookie;
              }
            }
            const body = requestBody(entry.operation);
            applyAuth(auth, token, url, headers);

            return withConnectionDeadline(
              connection.name,
              timeoutMs,
              context.signal,
              async (signal) => {
                const requestInit: RequestInit = { method: entry.method, headers, signal };
                if (body && args.body !== undefined) {
                  headers['content-type'] = 'application/json';
                  requestInit.body = JSON.stringify(args.body);
                }

                const response = await fetchConnection(
                  url,
                  requestInit,
                  allowedHosts,
                  connection.name,
                );
                if (response.status === 401) {
                  await response.body?.cancel();
                  throw new ConnectionAuthorizationRequiredError(connection.name, instanceId);
                }
                if (!response.ok) {
                  throw new ConnectionRequestError(
                    connection.name,
                    response.status,
                    (await safeText(response, maxResponseBytes)).slice(0, 512),
                  );
                }
                return readResponse(response, maxResponseBytes, connection.name);
              },
            );
          },
        ),
    });
    recordForeignSchemaBytes(definition, jsonSchemaBytes(schema));
    return definition;
  });
}

async function loadOpenApiDocument(
  connection: OpenApiConnection,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<{ document: Record<string, unknown>; url?: string }> {
  if (typeof connection.spec === 'object' && connection.spec !== null) {
    if (!isRecord(connection.spec)) {
      throw new Error(`OpenAPI spec of "${connection.name}" is not an object`);
    }
    return { document: connection.spec };
  }
  const text = connection.spec.trim();
  if (text.startsWith('{')) {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed))
      throw new Error(`OpenAPI spec of "${connection.name}" is not an object`);
    return { document: parsed };
  }
  const url = assertConnectionUrl(text, connection.name);
  const parsed = await withConnectionDeadline(
    connection.name,
    timeoutMs,
    undefined,
    async (signal) => {
      const response = await fetchConnection(
        url,
        { signal },
        connectionAllowedHosts(url, connection.allowHosts),
        connection.name,
      );
      if (!response.ok) {
        throw new ConnectionRequestError(connection.name, response.status, '');
      }
      return readBoundedJson(response, maxResponseBytes, connection.name);
    },
  );
  if (!isRecord(parsed)) throw new Error(`OpenAPI spec at ${url} is not an object`);
  return { document: parsed, url: url.toString() };
}

function resolveBaseUrl(
  connection: OpenApiConnection,
  document: Record<string, unknown>,
  specUrl: string | undefined,
): string {
  if (connection.baseUrl) return connection.baseUrl;
  const servers = document.servers;
  if (Array.isArray(servers)) {
    for (const server of servers) {
      if (isRecord(server) && typeof server.url === 'string' && server.url) return server.url;
    }
  }
  if (specUrl) return specUrl;
  throw new Error(`OpenAPI connection "${connection.name}" declares no baseUrl or server`);
}

function collectOperations(document: Record<string, unknown>): OpenApiOperation[] {
  const paths = asRecord(document.paths);
  if (!paths) return [];
  const operations: OpenApiOperation[] = [];
  for (const [path, rawItem] of Object.entries(paths)) {
    const pathItem = asRecord(rawItem);
    if (!pathItem) continue;
    for (const [rawMethod, method] of Object.entries(HTTP_METHODS)) {
      const operation = asRecord(pathItem[rawMethod]);
      if (!operation) continue;
      operations.push({ method, path, operation, pathItem });
    }
  }
  return operations;
}

const HTTP_METHODS: Record<string, HttpMethod> = {
  get: 'GET',
  head: 'HEAD',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  delete: 'DELETE',
};

function operationKey(entry: OpenApiOperation): string {
  const id = entry.operation.operationId;
  if (typeof id === 'string' && id.trim()) return id;
  return `${entry.method}_${entry.path}`;
}

function uniqueToolName(connectionName: string, rawName: string, used: Set<string>): string {
  const base = `${sanitizeToolName(connectionName)}__${sanitizeToolName(rawName)}`;
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let suffix = 2;
  while (used.has(`${base}_${suffix}`)) suffix += 1;
  const name = `${base}_${suffix}`;
  used.add(name);
  return name;
}

interface OperationParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required: boolean;
  schema?: Record<string, unknown>;
}

function operationParameters(
  document: Record<string, unknown>,
  entry: OpenApiOperation,
): OperationParameter[] {
  const merged = new Map<string, OperationParameter>();
  for (const source of [entry.pathItem.parameters, entry.operation.parameters]) {
    if (!Array.isArray(source)) continue;
    for (const raw of source) {
      const parameter = asRecord(raw);
      if (!parameter || typeof parameter.name !== 'string') continue;
      const location = parameter.in;
      if (
        location !== 'path' &&
        location !== 'query' &&
        location !== 'header' &&
        location !== 'cookie'
      ) {
        continue;
      }
      const resolved = resolveRef(document, asRecord(parameter.schema));
      merged.set(`${location}:${parameter.name}`, {
        name: parameter.name,
        in: location,
        required: parameter.required === true || location === 'path',
        ...(resolved && { schema: resolved }),
      });
    }
  }
  return [...merged.values()];
}

function requestBody(operation: Record<string, unknown>): boolean {
  const body = asRecord(operation.requestBody);
  if (!body) return false;
  const content = asRecord(body.content);
  return Boolean(content && isRecord(content['application/json']));
}

function operationInputSchema(
  document: Record<string, unknown>,
  entry: OpenApiOperation,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const parameter of operationParameters(document, entry)) {
    properties[parameter.name] = parameter.schema ?? { type: 'string' };
    if (parameter.required) required.push(parameter.name);
  }
  const body = asRecord(entry.operation.requestBody);
  const content = body ? asRecord(body.content) : undefined;
  const json = content ? asRecord(content['application/json']) : undefined;
  if (body && json) {
    properties.body = resolveRef(document, asRecord(json.schema)) ?? {};
    if (body.required === true) required.push('body');
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 && { required }),
  };
}

function resolveRef(
  document: Record<string, unknown>,
  node: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!node) return undefined;
  const ref = node.$ref;
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return node;
  const segments = ref
    .slice(2)
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  let current: unknown = document;
  for (const segment of segments) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return asRecord(current);
}

function resolveAuth(
  document: Record<string, unknown>,
  operation: Record<string, unknown>,
): ResolvedOpenApiAuth | undefined {
  const security = operation.security ?? document.security;
  if (!Array.isArray(security)) return undefined;
  for (const requirement of security) {
    const record = asRecord(requirement);
    if (!record) continue;
    const schemeName = Object.keys(record)[0];
    if (!schemeName) return undefined;
    const scheme = asRecord(
      asRecord(asRecord(document.components)?.securitySchemes)?.[schemeName],
    );
    if (!scheme) continue;
    const type = scheme.type;
    if (type === 'apiKey') {
      const placement = scheme.in;
      const headerName = scheme.name;
      if (
        typeof headerName === 'string' &&
        (placement === 'header' || placement === 'query' || placement === 'cookie')
      ) {
        return { placement, name: headerName, scheme: 'apikey' };
      }
      continue;
    }
    if (type === 'http') {
      const httpScheme = typeof scheme.scheme === 'string' ? scheme.scheme.toLowerCase() : '';
      if (httpScheme === 'basic')
        return { placement: 'header', name: 'authorization', scheme: 'basic' };
      if (httpScheme === 'bearer')
        return { placement: 'header', name: 'authorization', scheme: 'bearer' };
      continue;
    }
    if (type === 'oauth2' || type === 'openIdConnect') {
      return { placement: 'header', name: 'authorization', scheme: 'bearer' };
    }
  }
  if (security.length > 0)
    throw new TypeError('OpenAPI security has no supported alternative');
  return undefined;
}

function applyAuth(
  auth: ResolvedOpenApiAuth | undefined,
  token: string | undefined,
  url: URL,
  headers: Record<string, string>,
): void {
  if (!auth || token === undefined) return;
  const value =
    auth.scheme === 'basic'
      ? `Basic ${btoa(token)}`
      : auth.scheme === 'bearer'
        ? `Bearer ${token}`
        : token;
  if (auth.placement === 'query') url.searchParams.set(auth.name, value);
  else if (auth.placement === 'cookie') {
    headers.cookie = headers.cookie
      ? `${headers.cookie}; ${auth.name}=${value}`
      : `${auth.name}=${value}`;
  } else headers[auth.name] = value;
}

function operationServerUrl(entry: OpenApiOperation): string | undefined {
  for (const source of [entry.operation.servers, entry.pathItem.servers]) {
    if (!Array.isArray(source)) continue;
    for (const server of source) {
      if (isRecord(server) && typeof server.url === 'string' && server.url) return server.url;
    }
  }
  return undefined;
}

function buildOperationUrl(
  baseUrl: string,
  entry: OpenApiOperation,
  args: Record<string, unknown>,
): URL {
  let path = entry.path;
  for (const parameter of operationParameters({}, entry)) {
    if (parameter.in !== 'path') continue;
    const value = args[parameter.name];
    if (value === undefined) continue;
    path = path.replace(`{${parameter.name}}`, encodeURIComponent(String(value)));
  }
  const origin = operationServerUrl(entry) ?? baseUrl;
  const resolved = `${origin.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  return new URL(resolved);
}

async function readResponse(
  response: Response,
  maxBytes: number,
  connectionName: string,
): Promise<unknown> {
  if (response.status === 204) return null;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('json')) return readBoundedJson(response, maxBytes, connectionName);
  return readBoundedText(response, maxBytes, connectionName);
}

async function safeText(response: Response, maxBytes: number): Promise<string> {
  try {
    return await readBoundedText(response, maxBytes, 'response');
  } catch {
    return '';
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}
