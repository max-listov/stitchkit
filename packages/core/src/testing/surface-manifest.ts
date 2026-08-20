import { createHash } from 'node:crypto';
import { type ZodObject, type ZodType, z } from 'zod';
import type { EndpointToolAnnotations, HttpMethod } from '../contract';
import { isRecord } from '../internal/typed';
import type { RouteGroup, ServiceDef } from '../server/types';
import type { CliCommandDefinition } from '../tools/cli-command';
import { toJsonSchema } from '../tools/json-schema';
import { assertToolName, assertUniqueToolName, toToolName } from '../tools/names';

const HttpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
const ToolTransportSchema = z.enum(['MCP', 'AGENT', 'CLI']);

export const SurfaceSchemaDigestsSchema = z.object({
  params: z.string().nullable(),
  input: z.string().nullable(),
  output: z.string().nullable(),
  multipart: z.string().nullable(),
});

export const SurfaceManifestOperationSchema = z.object({
  kind: z.enum(['contract', 'runtime']),
  service: z.string(),
  action: z.string(),
  method: HttpMethodSchema,
  scope: z.string().nullable(),
  description: z.string(),
  schemas: SurfaceSchemaDigestsSchema,
  http: z.array(z.object({ method: HttpMethodSchema, path: z.string() })),
  tools: z.partialRecord(ToolTransportSchema, z.string()),
});

export const SurfaceManifestCliCommandSchema = z.object({
  name: z.string(),
  description: z.string(),
  input: z.string(),
  output: z.string().nullable(),
});

export const SurfaceManifestExtensionSchema = z.object({
  name: z.string(),
  transport: z.enum(['HTTP', 'MCP', 'AGENT', 'CLI']),
});

export const SurfaceManifestSchema = z.object({
  manifestVersion: z.literal(1),
  digestVersion: z.literal(1),
  operations: z.array(SurfaceManifestOperationSchema),
  cliOnly: z.array(SurfaceManifestCliCommandSchema),
  extensions: z.array(SurfaceManifestExtensionSchema),
});

export type SurfaceManifest = z.infer<typeof SurfaceManifestSchema>;
export type SurfaceManifestOperation = z.infer<typeof SurfaceManifestOperationSchema>;
export type SurfaceManifestExtension = z.infer<typeof SurfaceManifestExtensionSchema>;

/** Peer-free structural subset needed to describe a pathless runtime operation. */
export interface SurfaceRuntimeToolDefinition {
  name: string;
  description: string;
  identity: {
    serviceName: string;
    action: string;
    method: HttpMethod;
    scope?: string;
  };
  input: ZodObject;
  output?: ZodType;
  transports?: readonly ('MCP' | 'AGENT' | 'CLI')[];
  annotations?: EndpointToolAnnotations;
}

export interface SurfaceManifestConfig {
  services?: readonly ServiceDef[];
  groups?: readonly Pick<RouteGroup, 'pathPrefix' | 'services'>[];
  scopePrefixes?: Readonly<Record<string, string>>;
  runtimeTools?: readonly SurfaceRuntimeToolDefinition[];
  cliCommands?: readonly CliCommandDefinition[];
  extensions?: readonly SurfaceManifestExtension[];
}

function compareCodepoints(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort(compareCodepoints)) {
    result[key] = canonicalValue(value[key]);
  }
  return result;
}

/** Canonical bytes used by snapshots and schema digests. Arrays retain order. */
export function serializeSurfaceValue(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function digestValue(value: unknown): string {
  return createHash('sha256').update(serializeSurfaceValue(value)).digest('hex').slice(0, 16);
}

function canonicalSchemaValue(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) {
    const entries = value.map((entry) => canonicalSchemaValue(entry));
    return parentKey === 'required' && entries.every((entry) => typeof entry === 'string')
      ? entries.sort((left, right) => compareCodepoints(String(left), String(right)))
      : entries;
  }
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort(compareCodepoints)) {
    result[key] = canonicalSchemaValue(value[key], key);
  }
  return result;
}

function schemaDigest(schema: ZodType | undefined, io: 'input' | 'output'): string | null {
  if (!schema) return null;
  return digestValue(canonicalSchemaValue(toJsonSchema(schema, io, 'any')));
}

function multipartDigest(value: unknown): string | null {
  return value === undefined ? null : digestValue(value);
}

function joinPath(...parts: Array<string | undefined>): string {
  const joined = parts
    .filter((part): part is string => Boolean(part))
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return `/${joined}`;
}

function operationKey(kind: 'contract' | 'runtime', service: string, action: string): string {
  return `${kind}\u0000${service}\u0000${action}`;
}

function uniqueToolServices(config: SurfaceManifestConfig): ServiceDef[] {
  const services = new Set<ServiceDef>();
  for (const service of config.services ?? []) services.add(service);
  for (const group of config.groups ?? []) {
    for (const service of group.services) services.add(service);
  }
  return [...services];
}

/** Build one versioned snapshot of the declared HTTP/tool/CLI surface. */
export function buildSurfaceManifest(config: SurfaceManifestConfig): SurfaceManifest {
  const operations = new Map<string, SurfaceManifestOperation>();

  const addContract = (service: ServiceDef, prefix: string): void => {
    for (const method of Object.values(service.methods)) {
      const key = operationKey('contract', service.name, method.key);
      const existing = operations.get(key);
      const http =
        !method.expose || method.expose.includes('HTTP')
          ? [{ method: method.method, path: joinPath(prefix, service.prefix, method.path) }]
          : [];
      if (existing) {
        existing.http.push(...http);
        continue;
      }
      operations.set(key, {
        kind: 'contract',
        service: service.name,
        action: method.key,
        method: method.method,
        scope: method.scope ?? service.scope ?? null,
        description: method.desc,
        schemas: {
          params: schemaDigest(method.paramsSchema, 'input'),
          input: schemaDigest(method.inputSchema, 'input'),
          output: schemaDigest(method.outputSchema, 'output'),
          multipart: multipartDigest(method.multipart),
        },
        http,
        tools: {},
      });
    }
  };

  for (const service of config.services ?? []) {
    addContract(service, config.scopePrefixes?.[service.scope] ?? '');
  }
  for (const group of config.groups ?? []) {
    for (const service of group.services) addContract(service, group.pathPrefix ?? '');
  }

  for (const definition of config.runtimeTools ?? []) {
    const identity = definition.identity;
    const key = operationKey('runtime', identity.serviceName, identity.action);
    if (operations.has(key)) {
      throw new Error(
        `Duplicate runtime operation identity ${identity.serviceName}.${identity.action}`,
      );
    }
    operations.set(key, {
      kind: 'runtime',
      service: identity.serviceName,
      action: identity.action,
      method: identity.method,
      scope: identity.scope ?? null,
      description: definition.description,
      schemas: {
        params: null,
        input: schemaDigest(definition.input, 'input'),
        output: schemaDigest(definition.output, 'output'),
        multipart: null,
      },
      http: [],
      tools: {},
    });
  }

  const usedNames = {
    MCP: new Set<string>(),
    AGENT: new Set<string>(),
    CLI: new Set<string>(),
  };
  const addTool = (
    operation: SurfaceManifestOperation,
    name: string,
    transport: 'MCP' | 'AGENT' | 'CLI',
  ): void => {
    if (transport !== 'CLI') assertToolName(name, operation.service, operation.action);
    const surface =
      transport === 'CLI'
        ? 'CLI command'
        : transport === 'MCP'
          ? 'MCP tool name'
          : 'agent tool name';
    assertUniqueToolName(name, usedNames[transport].has(name), surface);
    usedNames[transport].add(name);
    operation.tools[transport] = name;
  };

  for (const service of uniqueToolServices(config)) {
    for (const method of Object.values(service.methods)) {
      if (method.multipart || method.rawBody || method.rawResponse || method.responseMeta)
        continue;
      const operation = operations.get(operationKey('contract', service.name, method.key));
      if (!operation) continue;
      const name = method.toolName ?? toToolName(service.name, method.key);
      if (!method.expose || method.expose.includes('MCP')) addTool(operation, name, 'MCP');
      if (!method.expose || method.expose.includes('AGENT')) addTool(operation, name, 'AGENT');
      if (method.expose?.includes('CLI')) addTool(operation, name, 'CLI');
    }
  }
  for (const definition of config.runtimeTools ?? []) {
    const operation = operations.get(
      operationKey('runtime', definition.identity.serviceName, definition.identity.action),
    );
    if (!operation) continue;
    const transports: readonly ('MCP' | 'AGENT' | 'CLI')[] = definition.transports ?? [
      'MCP',
      'AGENT',
    ];
    for (const transport of transports) addTool(operation, definition.name, transport);
  }

  const cliOnly = (config.cliCommands ?? [])
    .map((command) => ({
      name: command.name,
      description: command.description,
      input: schemaDigest(command.input, 'input') ?? digestValue({}),
      output: schemaDigest(command.output, 'output'),
    }))
    .sort((left, right) => compareCodepoints(left.name, right.name));

  return SurfaceManifestSchema.parse({
    manifestVersion: 1,
    digestVersion: 1,
    operations: [...operations.values()].sort(
      (left, right) =>
        compareCodepoints(left.service, right.service) ||
        compareCodepoints(left.action, right.action) ||
        compareCodepoints(left.kind, right.kind),
    ),
    cliOnly,
    extensions: [...(config.extensions ?? [])].sort(
      (left, right) =>
        compareCodepoints(left.transport, right.transport) ||
        compareCodepoints(left.name, right.name),
    ),
  });
}

export function assertSurfaceManifestSnapshot(
  manifest: SurfaceManifest,
  snapshot: SurfaceManifest,
): void {
  const actual = serializeSurfaceValue(SurfaceManifestSchema.parse(manifest));
  const expected = serializeSurfaceValue(SurfaceManifestSchema.parse(snapshot));
  if (actual !== expected) {
    throw new Error(
      `Surface manifest diverged from its committed snapshot\nexpected: ${expected}\nactual: ${actual}`,
    );
  }
}
