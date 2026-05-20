import { toJsonSchema } from './json-schema';
import type { MountableTool } from './mount';

export interface ToolManifestEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Build a searchable manifest from collected tools — name, description and
 * JSON Schema for each. Use it to power a `tool_search` native tool: the app
 * decides the search algorithm and the unlock mechanism.
 */
export function buildToolManifest(tools: MountableTool[]): ToolManifestEntry[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.method.desc,
    inputSchema: toJsonSchema(t.schema, 'input'),
  }));
}
