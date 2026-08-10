import { createHash } from 'node:crypto';
import type { HttpMethod } from 'stitchkit/contract';
import type { OpenApiDocument, ServiceDef } from 'stitchkit/server';
import { listToolNames } from 'stitchkit/tools';
import { z } from 'zod';

export interface SurfaceManifestOperation {
  service: string;
  action: string;
  scope: string;
  hasInput: boolean;
  hasOutput: boolean;
  /** Digest of the input JSON Schema — a TYPE change flips it, not just presence. */
  inputShape: string | null;
  /** Digest of the output JSON Schema. */
  outputShape: string | null;
  http: Array<{ method: HttpMethod; path: string }>;
  tools: Partial<Record<'MCP' | 'AGENT' | 'CLI', string>>;
}

function schemaShape(schema: z.ZodType | undefined, io: 'input' | 'output'): string | null {
  if (!schema) return null;
  const document = z.toJSONSchema(schema, { io, unrepresentable: 'any' });
  return createHash('sha256').update(JSON.stringify(document)).digest('hex').slice(0, 16);
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
        scope: method.scope ?? service.scope,
        hasInput: Boolean(method.inputSchema),
        hasOutput: Boolean(method.outputSchema),
        inputShape: schemaShape(method.inputSchema, 'input'),
        outputShape: schemaShape(method.outputSchema, 'output'),
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

/**
 * Compare the LIVE manifest against the committed snapshot — the external
 * anchor that a source-level change (an `expose` edit, a schema type change, a
 * scope change) cannot move along with itself. Regenerate deliberately with
 * `bun run surface:snapshot` and review the diff.
 */
export function assertManifestMatchesSnapshot(
  manifest: readonly SurfaceManifestOperation[],
  snapshot: readonly SurfaceManifestOperation[],
): void {
  const actual = JSON.stringify(manifest, null, 2);
  const expected = JSON.stringify(snapshot, null, 2);
  if (actual !== expected) {
    throw new Error(
      `Declared surface diverged from the committed snapshot — if the change is intended, regenerate it with "bun run surface:snapshot" and review the diff.\nsnapshot: ${expected}\nactual: ${actual}`,
    );
  }
}

export function assertSurfaceConformance({
  manifest,
  openApi,
  mcpToolNames,
  agentToolNames,
  cliToolNames,
  metadata = 'require',
}: {
  manifest: readonly SurfaceManifestOperation[];
  openApi: Pick<OpenApiDocument, 'paths'>;
  mcpToolNames: readonly string[];
  agentToolNames: readonly string[];
  cliToolNames: readonly string[];
  /**
   * `'require'` (default) — the OpenAPI document must carry `x-stitchkit-*`
   * metadata and it is compared; `'ignore'` — an explicitly declared mode for
   * standard documents. A silent skip is not an option.
   */
  metadata?: 'require' | 'ignore';
}): void {
  const openApiOperations = Object.entries(openApi.paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => ['get', 'post', 'put', 'patch', 'delete', 'head'].includes(method))
      .map(([method, operation]) => ({ method: method.toUpperCase(), path, operation })),
  );
  assertSameSet(
    'HTTP/OpenAPI',
    manifest.flatMap((operation) =>
      operation.http.map((entry) => `${entry.method}:${entry.path}`),
    ),
    openApiOperations.map(({ method, path }) => `${method}:${path}`),
  );
  const carriesContractMetadata = openApiOperations.some(({ operation }) =>
    OpenApiOperationMetadataPresenceSchema.parse(operation),
  );
  if (metadata === 'require' && openApiOperations.length > 0 && !carriesContractMetadata) {
    throw new Error(
      'OpenAPI document carries no x-stitchkit-* contract metadata — pass metadata: "ignore" only for a deliberately standard document',
    );
  }
  if (metadata === 'require' && carriesContractMetadata) {
    assertSameSet(
      'HTTP/OpenAPI contract metadata',
      manifest.flatMap((operation) =>
        operation.http.map(
          (entry) =>
            `${entry.method}:${entry.path}:${operation.scope}:${operation.hasInput}:${operation.hasOutput}`,
        ),
      ),
      openApiOperations.map(({ method, path, operation }) => {
        const metadata = OpenApiOperationMetadataSchema.parse(operation);
        return `${method}:${path}:${metadata['x-stitchkit-scope']}:${metadata['x-stitchkit-has-input']}:${metadata['x-stitchkit-has-output']}`;
      }),
    );
  }
  assertSameSet(
    'MCP discovery',
    manifest.flatMap((operation) => (operation.tools.MCP ? [operation.tools.MCP] : [])),
    mcpToolNames,
  );
  assertSameSet(
    'AGENT mount',
    manifest.flatMap((operation) => (operation.tools.AGENT ? [operation.tools.AGENT] : [])),
    agentToolNames,
  );
  assertSameSet(
    'CLI manifest',
    manifest.flatMap((operation) => (operation.tools.CLI ? [operation.tools.CLI] : [])),
    cliToolNames,
  );
}

const OpenApiOperationMetadataSchema = z.object({
  'x-stitchkit-scope': z.string(),
  'x-stitchkit-has-input': z.boolean(),
  'x-stitchkit-has-output': z.boolean(),
});

const OpenApiOperationMetadataPresenceSchema = z
  .object({
    'x-stitchkit-scope': z.unknown().optional(),
    'x-stitchkit-has-input': z.unknown().optional(),
    'x-stitchkit-has-output': z.unknown().optional(),
  })
  .transform(
    (metadata) =>
      metadata['x-stitchkit-scope'] !== undefined ||
      metadata['x-stitchkit-has-input'] !== undefined ||
      metadata['x-stitchkit-has-output'] !== undefined,
  );
