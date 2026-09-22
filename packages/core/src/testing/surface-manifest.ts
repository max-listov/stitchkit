import { createHash } from 'node:crypto';
import { type ZodType, z } from 'zod';
import type { EndpointMcpPolicy, HttpMethod } from '../contract';
import { compareCodepoints, serializeCanonicalJson } from '../internal/canonical-json';
import { joinRoutePath } from '../internal/route-pattern';
import { isRecord } from '../internal/typed';
import type { RealtimeContract, RealtimeEventRegistry } from '../realtime/contract';
import type { RouteGroup, ServiceDef } from '../server/types';
import type { CliCommandDefinition } from '../tools/cli-command';
import {
  type McpSchemaValidationConfig,
  mcpProjectionCandidate,
  prepareProjectedMcpTools,
  projectToolSurface,
  type SurfaceRuntimeToolDefinition,
  type SurfaceToolExtension,
} from '../tools/internal/surface-projector';
import { toJsonSchema } from '../tools/json-schema';
import { staticInputRounds } from '../tools/mcp-round-policy';

/** The snapshot format's own version — bumped whenever an operation gains a field. */
export const SURFACE_MANIFEST_VERSION = 3;

const HttpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
const ToolTransportSchema = z.enum(['MCP', 'AGENT', 'CLI']);
const SurfaceTransportSchema = z.enum(['HTTP', 'MCP', 'AGENT', 'CLI', 'REALTIME']);

export const SurfaceSchemaDigestsSchema = z.object({
  params: z.string().nullable(),
  input: z.string().nullable(),
  output: z.string().nullable(),
  multipart: z.string().nullable(),
});

/**
 * The questions an operation asks before it runs, as the host sees them.
 *
 * `null` means the operation declares no MCP policy at all. A list means those
 * exact rounds; `'resolved-per-call'` means a resolver decides them and only
 * the fact that it does is fixed at declaration time. Gaining, losing or
 * changing any of this changes the contract a host is coded against, so it
 * belongs in the snapshot that review reads.
 */
export const SurfaceManifestOperationMcpSchema = z
  .object({
    inputRequired: z.union([
      z.array(
        z.object({ key: z.string(), message: z.string(), schema: z.string().nullable() }),
      ),
      z.literal('resolved-per-call'),
    ]),
  })
  .nullable();

export const SurfaceManifestOperationSchema = z.object({
  kind: z.enum(['contract', 'runtime']),
  service: z.string(),
  action: z.string(),
  method: HttpMethodSchema,
  scope: z.string().nullable(),
  description: z.string(),
  schemas: SurfaceSchemaDigestsSchema,
  mcp: SurfaceManifestOperationMcpSchema,
  http: z.array(z.object({ method: HttpMethodSchema, path: z.string() })),
});

export const SurfaceManifestToolSchema = z.object({
  kind: z.enum(['contract', 'runtime']),
  service: z.string(),
  action: z.string(),
  name: z.string(),
  input: z.string(),
});

export const SurfaceManifestToolSurfaceSchema = z.object({
  transport: ToolTransportSchema,
  surface: z.string().nullable(),
  tools: z.array(SurfaceManifestToolSchema),
});

export const SurfaceManifestCliCommandSchema = z.object({
  name: z.string(),
  description: z.string(),
  input: z.string(),
  output: z.string().nullable(),
});

export const SurfaceManifestExtensionSchema = z.object({
  name: z.string(),
  transport: SurfaceTransportSchema,
});

export const SurfaceRealtimeSchemaPairSchema = z.object({
  input: z.string(),
  output: z.string(),
});

export const SurfaceManifestRealtimeEventSchema = z.object({
  contract: z.string(),
  direction: z.enum(['serverToClient', 'clientToServer']),
  event: z.string(),
  args: SurfaceRealtimeSchemaPairSchema,
  acknowledgement: SurfaceRealtimeSchemaPairSchema.nullable(),
});

export const SurfaceManifestSchema = z.object({
  manifestVersion: z.literal(SURFACE_MANIFEST_VERSION),
  digestVersion: z.literal(1),
  operations: z.array(SurfaceManifestOperationSchema),
  toolSurfaces: z.array(SurfaceManifestToolSurfaceSchema),
  realtimeContracts: z.array(z.string()),
  realtime: z.array(SurfaceManifestRealtimeEventSchema),
  cliOnly: z.array(SurfaceManifestCliCommandSchema),
  extensions: z.array(SurfaceManifestExtensionSchema),
});

export type SurfaceManifest = z.infer<typeof SurfaceManifestSchema>;
export type SurfaceManifestOperation = z.infer<typeof SurfaceManifestOperationSchema>;
export type SurfaceManifestOperationMcp = z.infer<typeof SurfaceManifestOperationMcpSchema>;
export type SurfaceManifestTool = z.infer<typeof SurfaceManifestToolSchema>;
export type SurfaceManifestToolSurface = z.infer<typeof SurfaceManifestToolSurfaceSchema>;
export type SurfaceManifestRealtimeEvent = z.infer<typeof SurfaceManifestRealtimeEventSchema>;
export type SurfaceManifestExtension = z.infer<typeof SurfaceManifestExtensionSchema>;

/** Peer-free runtime-operation descriptor consumed only by manifest projection. */
export type {
  IncompatibleSchemaPolicy,
  McpSchemaValidationConfig,
  SurfaceRuntimeToolDefinition,
  SurfaceToolExtension,
} from '../tools/internal/surface-projector';

/** Plain service/runtime selection shared by every tool transport. */
export interface SurfaceToolDefinition {
  services?: readonly ServiceDef[];
  runtimeTools?: readonly SurfaceRuntimeToolDefinition[];
}

/** Agent is the only non-MCP projection with presentation-shaping options. */
export interface SurfaceAgentProjection extends SurfaceToolDefinition {
  extend?: SurfaceToolExtension;
  flattenUnionInput?: boolean;
}

/** Global MCP preparation policy shared by direct and finite named surfaces. */
export interface SurfaceMcpPreparation {
  extend?: SurfaceToolExtension;
  flattenUnionInput?: boolean;
  schemaValidation?: McpSchemaValidationConfig;
  multiRound?: { stateConfigured: boolean; maxRounds: number };
}

export interface SurfaceManifestConfig {
  /** Shared shorthand: HTTP services plus every tool transport unless overridden below. */
  services?: readonly ServiceDef[];
  groups?: readonly Pick<RouteGroup, 'pathPrefix' | 'services'>[];
  scopePrefixes?: Readonly<Record<string, string>>;
  runtimeTools?: readonly SurfaceRuntimeToolDefinition[];
  /** Explicit static projections replace the shared shorthand for that transport. */
  toolSurfaces?: {
    MCP?: SurfaceToolDefinition;
    AGENT?: SurfaceAgentProjection;
    CLI?: SurfaceToolDefinition;
  };
  /** Finite MCP alternatives selected by the application at runtime. */
  mcpSurfaces?: Readonly<Record<string, SurfaceToolDefinition>>;
  /** One preparation policy, matching the real MCP server's global configuration. */
  mcpPreparation?: SurfaceMcpPreparation;
  /** Realtime contracts are named by the manifest, not by the runtime contract API. */
  realtime?: Readonly<
    Record<string, RealtimeContract<RealtimeEventRegistry, RealtimeEventRegistry>>
  >;
  cliCommands?: readonly CliCommandDefinition[];
  extensions?: readonly SurfaceManifestExtension[];
}

/** Canonical bytes used by snapshots and schema digests. Arrays retain order. */
export const serializeSurfaceValue = serializeCanonicalJson;

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

function presentationDigest(schema: Record<string, unknown>): string {
  return digestValue(canonicalSchemaValue(schema));
}

function multipartDigest(value: unknown): string | null {
  return value === undefined ? null : digestValue(value);
}

function operationKey(kind: 'contract' | 'runtime', service: string, action: string): string {
  return `${kind}\u0000${service}\u0000${action}`;
}

interface OperationSource {
  /** Original immutable definition; mount prefixes may differ, definitions may not. */
  definitionToken?: object;
  method: HttpMethod;
  serviceName: string;
  key: string;
  desc: string;
  scope?: string;
  paramsSchema?: ZodType;
  inputSchema?: ZodType;
  outputSchema?: ZodType;
  multipart?: unknown;
  path?: string;
  expose?: readonly string[];
  toolName?: string;
  annotations?: unknown;
  ui?: unknown;
  mcp?: EndpointMcpPolicy;
  rawBody?: true;
  safelistedBody?: true;
  rawResponse?: true;
  responseMeta?: unknown;
  maxJsonBodyBytes?: number;
  idempotent?: boolean;
  contentType?: string;
  meta?: Record<string, unknown>;
}

function operationFrom(
  kind: 'contract' | 'runtime',
  source: OperationSource,
): SurfaceManifestOperation {
  return {
    kind,
    service: source.serviceName,
    action: source.key,
    method: source.method,
    scope: source.scope ?? null,
    description: source.desc,
    schemas: {
      params: schemaDigest(source.paramsSchema, 'input'),
      input: schemaDigest(source.inputSchema, 'input'),
      output: schemaDigest(source.outputSchema, 'output'),
      multipart: multipartDigest(source.multipart),
    },
    mcp: mcpRoundsOf(source),
    http: [],
  };
}

/**
 * What a tool's multi-round declaration looks like from outside.
 *
 * A policy whose rounds are chosen per call has no list to write down, and
 * pretending it has an empty one would make a dynamic tool indistinguishable
 * from a tool that asks nothing. The marker says which kind it is, which is the
 * part of it that is actually fixed at declaration time.
 *
 * One function, because the snapshot and the fingerprint must not be able to
 * disagree about what was declared: the fingerprint decides whether two
 * declarations of one operation conflict, the snapshot decides whether a change
 * is visible to review, and a shape that drifts between them would let a
 * contract change pass one and fail the other.
 */
function mcpRoundsOf(source: OperationSource): SurfaceManifestOperationMcp {
  if (!source.mcp) return null;
  const declared = staticInputRounds(source.mcp);
  return {
    inputRequired: declared
      ? declared.map((request) => ({
          key: request.key,
          message: request.message,
          schema: schemaDigest(request.schema, 'input'),
        }))
      : 'resolved-per-call',
  };
}

function operationFingerprint(source: OperationSource): string {
  const mcp = mcpRoundsOf(source);
  return serializeSurfaceValue({
    method: source.method,
    serviceName: source.serviceName,
    key: source.key,
    desc: source.desc,
    scope: source.scope ?? null,
    path: source.path ?? null,
    expose: source.expose ? [...source.expose].sort(compareCodepoints) : null,
    toolName: source.toolName ?? null,
    annotations: source.annotations ?? null,
    ui: source.ui ?? null,
    mcp,
    rawBody: source.rawBody ?? false,
    safelistedBody: source.safelistedBody ?? false,
    rawResponse: source.rawResponse ?? false,
    responseMeta: source.responseMeta ?? null,
    maxJsonBodyBytes: source.maxJsonBodyBytes ?? null,
    idempotent: source.idempotent ?? false,
    contentType: source.contentType ?? null,
    meta: source.meta ?? null,
    schemas: {
      params: schemaDigest(source.paramsSchema, 'input'),
      input: schemaDigest(source.inputSchema, 'input'),
      output: schemaDigest(source.outputSchema, 'output'),
      multipart: multipartDigest(source.multipart),
    },
  });
}

function sortTools(tools: SurfaceManifestTool[]): SurfaceManifestTool[] {
  return tools.sort(
    (left, right) =>
      compareCodepoints(left.name, right.name) ||
      compareCodepoints(left.service, right.service) ||
      compareCodepoints(left.action, right.action) ||
      compareCodepoints(left.kind, right.kind),
  );
}

/** Build one versioned snapshot of the declared transport-specific surface. */
export function buildSurfaceManifest(config: SurfaceManifestConfig): SurfaceManifest {
  const operations = new Map<string, SurfaceManifestOperation>();
  const operationFingerprints = new Map<string, string>();
  const operationDefinitions = new Map<string, object>();

  const addOperation = (
    kind: 'contract' | 'runtime',
    source: OperationSource,
  ): SurfaceManifestOperation => {
    const candidate = operationFrom(kind, source);
    const key = operationKey(kind, candidate.service, candidate.action);
    const definition = source.definitionToken ?? source;
    const existing = operations.get(key);
    if (!existing) {
      operations.set(key, candidate);
      operationFingerprints.set(key, operationFingerprint(source));
      operationDefinitions.set(key, definition);
      return candidate;
    }
    if (
      operationDefinitions.get(key) !== definition ||
      operationFingerprints.get(key) !== operationFingerprint(source)
    ) {
      throw new Error(
        `Conflicting ${kind} operation identity ${candidate.service}.${candidate.action}`,
      );
    }
    return existing;
  };

  const addHttp = (service: ServiceDef, prefix: string): void => {
    for (const method of Object.values(service.methods)) {
      const operation = addOperation('contract', method);
      if (method.expose && !method.expose.includes('HTTP')) continue;
      const route = {
        method: method.method,
        path: joinRoutePath(prefix, service.prefix, method.path),
      };
      if (
        !operation.http.some(
          (entry) => entry.method === route.method && entry.path === route.path,
        )
      ) {
        operation.http.push(route);
      }
    }
  };

  for (const service of config.services ?? []) {
    addHttp(service, config.scopePrefixes?.[service.scope] ?? '');
  }
  for (const group of config.groups ?? []) {
    for (const service of group.services) addHttp(service, group.pathPrefix ?? '');
  }

  const toolSurfaces: SurfaceManifestToolSurface[] = [];
  const addToolProjection = (
    transport: 'MCP' | 'AGENT' | 'CLI',
    surface: string | null,
    projection: SurfaceToolDefinition,
    presentation: Pick<SurfaceAgentProjection, 'extend' | 'flattenUnionInput'> = {},
  ): void => {
    const projected = projectToolSurface(
      projection,
      transport,
      transport === 'MCP' ? (config.mcpPreparation ?? {}) : presentation,
    );
    const collected =
      transport === 'MCP'
        ? prepareProjectedMcpTools(
            projected.map(mcpProjectionCandidate),
            config.mcpPreparation ?? {},
          ).map((prepared) => ({
            ...prepared.tool,
            presentationSchema: prepared.inputSchema,
          }))
        : projected;

    const tools: SurfaceManifestTool[] = [];
    for (const entry of collected) {
      const source: OperationSource =
        entry.kind === 'contract'
          ? entry.source
          : {
              definitionToken: entry.source,
              method: entry.source.identity.method,
              serviceName: entry.source.identity.serviceName,
              key: entry.source.identity.action,
              desc: entry.source.description,
              ...(entry.source.identity.scope !== undefined && {
                scope: entry.source.identity.scope,
              }),
              inputSchema: entry.source.input,
              ...(entry.source.output !== undefined && {
                outputSchema: entry.source.output,
              }),
              toolName: entry.source.name,
              expose: entry.source.transports,
              ...(entry.source.annotations !== undefined && {
                annotations: entry.source.annotations,
              }),
              ...(entry.source.ui !== undefined && { ui: entry.source.ui }),
              ...(entry.source.identity.meta !== undefined && {
                meta: entry.source.identity.meta,
              }),
              ...(entry.source.mcp !== undefined && { mcp: entry.source.mcp }),
            };
      const operation = addOperation(entry.kind, source);
      tools.push({
        kind: entry.kind,
        service: operation.service,
        action: operation.action,
        name: entry.name,
        input: presentationDigest(entry.presentationSchema),
      });
    }
    toolSurfaces.push({ transport, surface, tools: sortTools(tools) });
  };

  const shared: SurfaceToolDefinition = {
    services: config.services,
    runtimeTools: config.runtimeTools,
  };
  const explicitMcp = config.toolSurfaces?.MCP;
  const namedMcp = config.mcpSurfaces;
  if (explicitMcp && namedMcp) {
    throw new Error(
      'Surface manifest MCP topology must use either one direct surface or named surfaces',
    );
  }
  if (explicitMcp) addToolProjection('MCP', null, explicitMcp);
  if (namedMcp) {
    for (const name of Object.keys(namedMcp).sort(compareCodepoints)) {
      const projection = namedMcp[name];
      if (projection) addToolProjection('MCP', name, projection);
    }
  }
  if (!explicitMcp && !namedMcp) addToolProjection('MCP', null, shared);
  const agent = config.toolSurfaces?.AGENT;
  addToolProjection('AGENT', null, agent ?? shared, agent ?? {});
  addToolProjection('CLI', null, config.toolSurfaces?.CLI ?? shared);

  const realtime: SurfaceManifestRealtimeEvent[] = [];
  const realtimeContracts = Object.keys(config.realtime ?? {}).sort(compareCodepoints);
  for (const contractName of realtimeContracts) {
    const contract = config.realtime?.[contractName];
    if (!contract) continue;
    for (const direction of ['serverToClient', 'clientToServer'] satisfies Array<
      'serverToClient' | 'clientToServer'
    >) {
      const registry = contract[direction];
      for (const event of Object.keys(registry).sort(compareCodepoints)) {
        const definition = registry[event];
        if (!definition) continue;
        const argsInput = schemaDigest(definition.args, 'input');
        const argsOutput = schemaDigest(definition.args, 'output');
        if (!argsInput || !argsOutput) throw new Error('Realtime args schema digest missing');
        let acknowledgement: { input: string; output: string } | null = null;
        if (definition.ack) {
          const input = schemaDigest(definition.ack, 'input');
          const output = schemaDigest(definition.ack, 'output');
          if (!input || !output) throw new Error('Realtime ack schema digest missing');
          acknowledgement = { input, output };
        }
        realtime.push({
          contract: contractName,
          direction,
          event,
          args: { input: argsInput, output: argsOutput },
          acknowledgement,
        });
      }
    }
  }

  const cliOnly = (config.cliCommands ?? [])
    .map((command) => ({
      name: command.name,
      description: command.description,
      input: schemaDigest(command.input, 'input') ?? digestValue({}),
      output: schemaDigest(command.output, 'output'),
    }))
    .sort((left, right) => compareCodepoints(left.name, right.name));

  for (const operation of operations.values()) {
    operation.http.sort(
      (left, right) =>
        compareCodepoints(left.path, right.path) ||
        compareCodepoints(left.method, right.method),
    );
  }

  return SurfaceManifestSchema.parse({
    manifestVersion: SURFACE_MANIFEST_VERSION,
    digestVersion: 1,
    operations: [...operations.values()].sort(
      (left, right) =>
        compareCodepoints(left.service, right.service) ||
        compareCodepoints(left.action, right.action) ||
        compareCodepoints(left.kind, right.kind),
    ),
    toolSurfaces: toolSurfaces.sort(
      (left, right) =>
        compareCodepoints(left.transport, right.transport) ||
        compareCodepoints(left.surface ?? '', right.surface ?? ''),
    ),
    realtimeContracts,
    realtime,
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
  // A snapshot from an older format fails the schema on a literal, and the
  // resulting "expected 3, received 2" says nothing about what to do. The
  // remedy is always the same and belongs in the message.
  const committed = (snapshot as { manifestVersion?: unknown }).manifestVersion;
  if (committed !== SURFACE_MANIFEST_VERSION) {
    throw new Error(
      `Surface snapshot is manifestVersion ${String(committed)}; this build writes ` +
        `${SURFACE_MANIFEST_VERSION}. Regenerate it and review the diff — the format ` +
        'changed, so the first regeneration is expected to be large.',
    );
  }
  const actual = serializeSurfaceValue(SurfaceManifestSchema.parse(manifest));
  const expected = serializeSurfaceValue(SurfaceManifestSchema.parse(snapshot));
  if (actual !== expected) {
    throw new Error(
      `Surface manifest diverged from its committed snapshot\nexpected: ${expected}\nactual: ${actual}`,
    );
  }
}
