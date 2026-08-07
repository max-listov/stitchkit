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
 *
 * A tool whose schema cannot be represented as JSON Schema still appears —
 * with an empty `inputSchema` — so it stays discoverable by name / description
 * rather than crashing the whole manifest.
 */
export function buildToolManifest(tools: MountableTool[]): ToolManifestEntry[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.method.desc,
    inputSchema: tool.presentationSchema,
  }));
}
