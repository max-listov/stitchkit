/**
 * OpenAPI 3.1 generation from contracts. A `defineContract` already carries the
 * full type information — Zod `params` / `input` / `output`, `desc`, `method`,
 * `path`, `scope` — so the spec is generated, not hand-maintained: the contract
 * IS the spec. No decorators, no duplicated annotations. → ADR 0018.
 *
 * Schemas are converted through the same single `toJsonSchema` point the tool
 * layer uses (and `jsonSchemaFields`, shared with the CLI `--help` walker), so
 * the JSON Schema in the spec is the JSON Schema the rest of the framework
 * emits — not a divergent code path. Schemas are inlined (valid OpenAPI);
 * `$ref` de-duplication can come later if a spec grows unwieldy.
 */

import { inputIsQuery } from '../internal/http-input';
import { isRecord } from '../internal/typed';
import { jsonSchemaFields, toJsonSchema } from '../tools/json-schema';
import type { RawRoute, ServiceDef } from './types';

export interface OpenApiInfo {
  title: string;
  version: string;
  description?: string;
}

export interface OpenApiServer {
  url: string;
  description?: string;
}

export interface OpenApiConfig {
  info: OpenApiInfo;
  /** Flat services, mounted at their own prefix. */
  services?: ServiceDef[];
  /** Grouped services, each mounted under a path prefix (mirrors `RouteGroup`). */
  groups?: Array<{ pathPrefix?: string; services: ServiceDef[] }>;
  /** `servers` block for the spec. */
  servers?: OpenApiServer[];
}

export interface OpenApiDocument {
  openapi: '3.1.0';
  info: OpenApiInfo;
  servers?: OpenApiServer[];
  paths: Record<string, Record<string, unknown>>;
}

const ERROR_ENVELOPE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: {},
        hint: { type: 'string' },
      },
      required: ['code'],
    },
  },
  required: ['error'],
};

function joinPath(...parts: Array<string | undefined>): string {
  const joined = parts
    .filter((p): p is string => Boolean(p))
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return `/${joined}`;
}

/** `:param` → `{param}` for OpenAPI path templating. */
function toOpenApiPath(path: string): string {
  return path.replace(/:([^/]+)/g, '{$1}');
}

/**
 * Convert a Zod schema to JSON Schema for the spec. Uses `unrepresentable: 'any'`
 * so a single unrepresentable field (`z.date()`, `z.bigint()`, …) degrades to
 * `{}` in place instead of throwing and collapsing the whole endpoint's schema;
 * the outer `try` is a last-resort guard for any other conversion failure.
 */
function safeJson(
  schema: Parameters<typeof toJsonSchema>[0] | undefined,
  io: 'input' | 'output',
): Record<string, unknown> {
  if (!schema) return {};
  try {
    return toJsonSchema(schema, io, 'any');
  } catch {
    return {};
  }
}

function errorResponse(description: string): Record<string, unknown> {
  return {
    description,
    content: { 'application/json': { schema: ERROR_ENVELOPE_SCHEMA } },
  };
}

function errorResponses(scope: string | undefined): Record<string, unknown> {
  const responses: Record<string, unknown> = {
    '400': errorResponse('Validation error'),
    '500': errorResponse('Server error'),
  };
  if (scope && scope !== 'public') {
    responses['401'] = errorResponse('Unauthorized');
    responses['403'] = errorResponse('Forbidden');
  }
  return responses;
}

/**
 * Generate an OpenAPI 3.1 document from contract services. Only methods exposed
 * on HTTP are included — a method whose `expose` omits `'HTTP'` (an MCP/agent
 * only tool) is skipped, matching the router's own route-building rule.
 */
export function generateOpenApiDocument(config: OpenApiConfig): OpenApiDocument {
  const groups = [
    ...(config.services ?? []).map((service) => ({ pathPrefix: undefined, service })),
    ...(config.groups ?? []).flatMap((group) =>
      group.services.map((service) => ({ pathPrefix: group.pathPrefix, service })),
    ),
  ];

  const paths: Record<string, Record<string, unknown>> = {};

  for (const { pathPrefix, service } of groups) {
    for (const [key, method] of Object.entries(service.methods)) {
      if (method.expose && !method.expose.includes('HTTP')) continue;

      const servicePath = joinPath(
        '/',
        service.prefix,
        method.path === '/' ? '' : method.path,
      );
      const fullPath = toOpenApiPath(
        pathPrefix ? joinPath(pathPrefix, servicePath) : servicePath,
      );

      const parameters: Array<Record<string, unknown>> = [];
      for (const field of jsonSchemaFields(safeJson(method.paramsSchema, 'input'))) {
        parameters.push({
          name: field.name,
          in: 'path',
          required: true,
          schema: field.schema,
          ...(field.description && { description: field.description }),
        });
      }
      // GET and DELETE carry their input as query parameters (the typed client
      // sends both as query); the body verbs carry it as a request body. One
      // source of truth — `inputIsQuery` — shared with the typed client.
      const inputInQuery = inputIsQuery(method.method);
      if (inputInQuery && method.inputSchema) {
        for (const field of jsonSchemaFields(safeJson(method.inputSchema, 'input'))) {
          parameters.push({
            name: field.name,
            in: 'query',
            required: field.required,
            schema: field.schema,
            ...(field.description && { description: field.description }),
          });
        }
      }

      const responses: Record<string, unknown> = { ...errorResponses(method.scope) };
      if (method.outputSchema) {
        responses['200'] = {
          description: 'Success',
          content: { 'application/json': { schema: safeJson(method.outputSchema, 'output') } },
        };
      } else {
        responses['204'] = { description: 'No content' };
      }

      const operation: Record<string, unknown> = {
        summary: method.desc,
        operationId: `${service.name}_${key}`,
        ...(parameters.length > 0 && { parameters }),
        responses,
      };
      if (!inputInQuery && (method.inputSchema || method.multipart)) {
        if (method.multipart) {
          // A file-upload endpoint is `multipart/form-data` at runtime, with the
          // file under `method.multipart` plus the JSON-schema input fields.
          const inputJson = safeJson(method.inputSchema, 'input');
          const baseProps = isRecord(inputJson.properties) ? inputJson.properties : {};
          const baseRequired = Array.isArray(inputJson.required) ? inputJson.required : [];
          operation.requestBody = {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  properties: {
                    ...baseProps,
                    [method.multipart]: { type: 'string', format: 'binary' },
                  },
                  required: [...baseRequired, method.multipart],
                },
              },
            },
          };
        } else if (method.inputSchema) {
          // An all-optional body is not required — the runtime parses an empty
          // body as `{}`, so a spec that marks it required would be wrong.
          const required = jsonSchemaFields(safeJson(method.inputSchema, 'input')).some(
            (f) => f.required,
          );
          operation.requestBody = {
            required,
            content: { 'application/json': { schema: safeJson(method.inputSchema, 'input') } },
          };
        }
      }

      const pathItem = paths[fullPath] ?? {};
      pathItem[method.method.toLowerCase()] = operation;
      paths[fullPath] = pathItem;
    }
  }

  return {
    openapi: '3.1.0',
    info: config.info,
    ...(config.servers && { servers: config.servers }),
    paths,
  };
}

/**
 * A `RawRoute` that serves a generated OpenAPI document as JSON — mount it
 * alongside contract routes to expose `/openapi.json`.
 */
export function openApiRoute(path: string, document: OpenApiDocument): RawRoute {
  return {
    method: 'GET',
    path,
    handler: () => Response.json(document),
  };
}
