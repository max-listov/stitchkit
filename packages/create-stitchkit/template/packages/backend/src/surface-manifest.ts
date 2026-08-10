import type { HttpMethod } from 'stitchkit/contract';
import type { OpenApiDocument, ServiceDef } from 'stitchkit/server';
import { listToolNames } from 'stitchkit/tools';

export interface SurfaceManifestOperation {
  service: string;
  action: string;
  http: Array<{ method: HttpMethod; path: string }>;
  tools: Partial<Record<'MCP' | 'AGENT' | 'CLI', string>>;
}

function joinPath(...parts: Array<string | undefined>): string {
  const joined = parts
    .filter((part): part is string => Boolean(part))
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return `/${joined}`;
}

function operationKey(service: string, action: string): string {
  return `${service}\u0000${action}`;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function assertSameSet(
  label: string,
  expectedValues: Iterable<string>,
  actualValues: Iterable<string>,
) {
  const expected = sorted(expectedValues);
  const actual = sorted(actualValues);
  if (
    expected.length === actual.length &&
    expected.every((value, index) => value === actual[index])
  ) {
    return;
  }
  throw new Error(
    `${label} surface mismatch\nexpected: ${expected.join(', ') || '(empty)'}\nactual: ${actual.join(', ') || '(empty)'}`,
  );
}

export function buildSurfaceManifest(
  services: readonly ServiceDef[],
  pathPrefix = '/api',
): SurfaceManifestOperation[] {
  const operations = new Map<string, SurfaceManifestOperation>();
  for (const service of services) {
    for (const method of Object.values(service.methods)) {
      const key = operationKey(service.name, method.key);
      if (operations.has(key)) {
        throw new Error(`Duplicate operation identity ${service.name}.${method.key}`);
      }
      operations.set(key, {
        service: service.name,
        action: method.key,
        http:
          !method.expose || method.expose.includes('HTTP')
            ? [
                {
                  method: method.method,
                  path: joinPath(pathPrefix, service.prefix, method.path).replace(
                    /:([^/]+)/g,
                    '{$1}',
                  ),
                },
              ]
            : [],
        tools: {},
      });
    }
  }
  for (const tool of listToolNames({ services })) {
    const operation = operations.get(operationKey(tool.service, tool.method));
    if (!operation) {
      throw new Error(`Tool ${tool.name} has no contract identity`);
    }
    for (const transport of tool.transports) {
      if (transport !== 'HTTP') operation.tools[transport] = tool.name;
    }
  }
  return [...operations.values()].sort(
    (left, right) =>
      left.service.localeCompare(right.service) || left.action.localeCompare(right.action),
  );
}

export function assertSurfaceConformance({
  manifest,
  openApi,
  mcpToolNames,
}: {
  manifest: readonly SurfaceManifestOperation[];
  openApi: Pick<OpenApiDocument, 'paths'>;
  mcpToolNames: readonly string[];
}): void {
  assertSameSet(
    'HTTP/OpenAPI',
    manifest.flatMap((operation) =>
      operation.http.map((entry) => `${entry.method}:${entry.path}`),
    ),
    Object.entries(openApi.paths).flatMap(([path, item]) =>
      Object.keys(item)
        .filter((method) => ['get', 'post', 'put', 'patch', 'delete', 'head'].includes(method))
        .map((method) => `${method.toUpperCase()}:${path}`),
    ),
  );
  assertSameSet(
    'MCP discovery',
    manifest.flatMap((operation) => (operation.tools.MCP ? [operation.tools.MCP] : [])),
    mcpToolNames,
  );
}
