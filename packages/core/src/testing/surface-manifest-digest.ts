/**
 * What a surface manifest records about an operation, as digests: a schema's
 * canonical JSON Schema, a tool's presentation, and the fingerprint that tells
 * two definitions under one identity apart. Split from the builder so the
 * builder is the order of projections and nothing else.
 */
import { createHash } from 'node:crypto';
import type { ZodType } from 'zod';
import type { HttpMethod } from '../contract/define';
import type { EndpointMcpPolicy } from '../contract/tool-options';
import type { EndpointToolView } from '../contract/tool-view';
import { compareCodeUnits, serializeCanonicalJson } from '../internal/canonical-json';
import { isRecord } from '../internal/typed';
import { toJsonSchema } from '../json-schema/json-schema';
import type { SurfaceRuntimeToolDefinition } from '../tools/internal/surface-projector';
import { staticInputRounds } from '../tools/mcp/round-policy';
import type {
  SurfaceManifestOperation,
  SurfaceManifestOperationMcp,
  SurfaceManifestOperationToolView,
  SurfaceManifestTool,
} from './surface-manifest';

export function digestValue(value: unknown): string {
  return createHash('sha256').update(serializeCanonicalJson(value)).digest('hex').slice(0, 16);
}

function canonicalSchemaValue(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) {
    const entries = value.map((entry) => canonicalSchemaValue(entry));
    return parentKey === 'required' && entries.every((entry) => typeof entry === 'string')
      ? entries.sort((left, right) => compareCodeUnits(String(left), String(right)))
      : entries;
  }
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort(compareCodeUnits)) {
    result[key] = canonicalSchemaValue(value[key], key);
  }
  return result;
}

export function schemaDigest(
  schema: ZodType | undefined,
  io: 'input' | 'output',
): string | null {
  if (!schema) return null;
  return digestValue(canonicalSchemaValue(toJsonSchema(schema, io, 'any')));
}

export function presentationDigest(schema: Record<string, unknown>): string {
  return digestValue(canonicalSchemaValue(schema));
}

function multipartDigest(value: unknown): string | null {
  return value === undefined ? null : digestValue(value);
}

export function operationKey(
  kind: 'contract' | 'runtime',
  service: string,
  action: string,
): string {
  return `${kind}\u0000${service}\u0000${action}`;
}

export interface OperationSource {
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
  toolView?: EndpointToolView;
  rawBody?: true;
  safelistedBody?: true;
  rawResponse?: true;
  responseMeta?: unknown;
  maxJsonBodyBytes?: number;
  idempotent?: boolean;
  contentType?: string;
  meta?: Record<string, unknown>;
}

export function operationFrom(
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
    ...toolViewEntry(source),
    http: [],
  };
}

/**
 * The declared tool view, in the one shape both the snapshot and the
 * fingerprint read — the same reason `mcpRoundsOf` is one function.
 */
function toolViewOf(source: OperationSource): SurfaceManifestOperationToolView | null {
  const view = source.toolView;
  if (!view) return null;
  return {
    defaults:
      view.defaults === undefined || Object.keys(view.defaults).length === 0
        ? null
        : digestValue(view.defaults),
    output: schemaDigest(view.output, 'output'),
    project: view.project !== undefined,
  };
}

function toolViewEntry(source: OperationSource): {
  toolView?: SurfaceManifestOperationToolView;
} {
  const toolView = toolViewOf(source);
  return toolView ? { toolView } : {};
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

export function operationFingerprint(source: OperationSource): string {
  const mcp = mcpRoundsOf(source);
  return serializeCanonicalJson({
    method: source.method,
    serviceName: source.serviceName,
    key: source.key,
    desc: source.desc,
    scope: source.scope ?? null,
    path: source.path ?? null,
    expose: source.expose ? [...source.expose].sort(compareCodeUnits) : null,
    toolName: source.toolName ?? null,
    annotations: source.annotations ?? null,
    ui: source.ui ?? null,
    mcp,
    toolView: toolViewOf(source),
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

export function sortTools(tools: SurfaceManifestTool[]): SurfaceManifestTool[] {
  return tools.sort(
    (left, right) =>
      compareCodeUnits(left.name, right.name) ||
      compareCodeUnits(left.service, right.service) ||
      compareCodeUnits(left.action, right.action) ||
      compareCodeUnits(left.kind, right.kind),
  );
}

/** The operation a runtime tool definition stands for, in the shape contract methods have. */
export function runtimeOperationSource(source: SurfaceRuntimeToolDefinition): OperationSource {
  return {
    definitionToken: source,
    method: source.identity.method,
    serviceName: source.identity.serviceName,
    key: source.identity.action,
    desc: source.description,
    ...(source.identity.scope !== undefined && { scope: source.identity.scope }),
    inputSchema: source.input,
    ...(source.output !== undefined && { outputSchema: source.output }),
    toolName: source.name,
    expose: source.transports,
    ...(source.annotations !== undefined && { annotations: source.annotations }),
    ...(source.ui !== undefined && { ui: source.ui }),
    ...(source.identity.meta !== undefined && { meta: source.identity.meta }),
    ...(source.mcp !== undefined && { mcp: source.mcp }),
  };
}
