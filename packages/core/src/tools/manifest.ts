import type { ToolTransport } from '../contract/define';
import {
  projectToolSurface,
  type SurfaceRuntimeToolDefinition,
  type ToolSurfaceProjection,
} from './internal/surface-projector';
import type { CollectToolsConfig } from './mount';

export interface ToolManifestEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolManifestConfig
  extends ToolSurfaceProjection<SurfaceRuntimeToolDefinition> {
  /** Model-facing surface whose exposure rules the manifest must mirror. */
  transport: ToolTransport;
  extend?: CollectToolsConfig['extend'];
  flattenUnionInput?: boolean;
  /** Advertise inputs with no `$ref`, recursion unrolled this many levels — as the live mount. */
  inputRecursionDepth?: number;
}

export interface ToolCatalogEntry extends ToolManifestEntry {
  source: { kind: 'contract' | 'runtime'; service: string; action: string };
  schemaBytes: number;
  deferred: boolean;
}

export interface ToolCatalogConfig extends ToolManifestConfig {
  deferredNames?: readonly string[];
  /** Refuses only when explicitly configured. */
  maxSchemaBytes?: number;
}

function utf8Length(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** Inspect the exact model-facing catalog using the same projection as the live mount. */
export function describeToolCatalog(config: ToolCatalogConfig): ToolCatalogEntry[] {
  const deferred = new Set(config.deferredNames ?? []);
  const entries = projectToolSurface(config, config.transport, {
    extend: config.extend,
    flattenUnionInput: config.flattenUnionInput,
    inputRecursionDepth: config.inputRecursionDepth,
  }).map((projected) => {
    const schemaBytes = utf8Length(projected.presentationSchema);
    const description =
      projected.kind === 'contract' ? projected.source.desc : projected.source.description;
    return {
      name: projected.name,
      description,
      inputSchema: projected.presentationSchema,
      source: {
        kind: projected.kind,
        service: projected.serviceName,
        action: projected.action,
      },
      schemaBytes,
      deferred: deferred.has(projected.name),
    } satisfies ToolCatalogEntry;
  });
  if (config.maxSchemaBytes !== undefined) {
    const total = entries.reduce((sum, entry) => sum + entry.schemaBytes, 0);
    if (total > config.maxSchemaBytes) {
      throw new TypeError(
        `Tool catalog schemas use ${total} bytes, exceeding maxSchemaBytes ${config.maxSchemaBytes}`,
      );
    }
  }
  return entries;
}

/**
 * Build a searchable manifest from the complete contract/runtime surface —
 * name, description and JSON Schema for each. Use it to power a `tool_search`
 * tool: the app decides the search algorithm and the unlock mechanism.
 *
 * A tool whose schema cannot be represented as JSON Schema still appears —
 * with an empty `inputSchema` — so it stays discoverable by name / description
 * rather than crashing the whole manifest.
 */
export function buildToolManifest(config: ToolManifestConfig): ToolManifestEntry[] {
  return projectToolSurface(config, config.transport, {
    extend: config.extend,
    flattenUnionInput: config.flattenUnionInput,
    inputRecursionDepth: config.inputRecursionDepth,
  }).map((projected) => ({
    name: projected.name,
    description:
      projected.kind === 'contract' ? projected.source.desc : projected.source.description,
    inputSchema: projected.presentationSchema,
  }));
}
