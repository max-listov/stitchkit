import type { CollectToolsConfig } from './mount';
import type { RuntimeToolTransport } from './runtime-tool';
import { collectToolSurface, type ToolSurfaceDefinition } from './surface';

export interface ToolManifestEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolManifestConfig extends ToolSurfaceDefinition {
  /** Model-facing surface whose exposure rules the manifest must mirror. */
  transport: RuntimeToolTransport;
  extend?: CollectToolsConfig['extend'];
  flattenUnionInput?: boolean;
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
  return collectToolSurface({
    surface: config,
    transport: config.transport,
    extend: config.extend,
    flattenUnionInput: config.flattenUnionInput,
  }).map(({ mountable }) => ({
    name: mountable.name,
    description: mountable.method.desc,
    inputSchema: mountable.presentationSchema,
  }));
}
