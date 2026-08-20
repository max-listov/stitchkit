import type { Transport } from '../contract';
import type { ServiceDef } from '../server/types';
import { type CollectToolsConfig, collectTools, type MountableTool } from './mount';
import { assertUniqueToolName, type ToolNameSurface } from './names';
import {
  type RuntimeToolDefinition,
  runtimeToolMountable,
  runtimeToolSupports,
} from './runtime-tool';

export type ToolSurfaceTransport = Exclude<Transport, 'HTTP'>;

/** Contract and pathless runtime operations that form one tool surface. */
export interface ToolSurfaceDefinition {
  services?: readonly ServiceDef[];
  runtimeTools?: readonly RuntimeToolDefinition[];
}

interface CollectedContractTool {
  kind: 'contract';
  service: string;
  action: string;
  mountable: MountableTool;
}

interface CollectedRuntimeTool {
  kind: 'runtime';
  service: string;
  action: string;
  mountable: MountableTool;
  definition: RuntimeToolDefinition;
}

export type CollectedToolSurfaceEntry = CollectedContractTool | CollectedRuntimeTool;

export interface CollectToolSurfaceConfig extends CollectToolsConfig {
  surface: ToolSurfaceDefinition;
  transport: ToolSurfaceTransport;
  /** Diagnostics disable this so they can report a broken surface. Default: true. */
  assertUniqueNames?: boolean;
}

function duplicateLabel(transport: ToolSurfaceTransport): ToolNameSurface {
  if (transport === 'MCP') return 'MCP tool name';
  if (transport === 'AGENT') return 'agent tool name';
  return 'CLI command';
}

/**
 * Resolve contracts and runtime definitions in their real mount order through
 * the same name, exposure and presentation-schema machinery as the mounts.
 */
export function collectToolSurface({
  surface,
  transport,
  assertUniqueNames = true,
  ...collectConfig
}: CollectToolSurfaceConfig): CollectedToolSurfaceEntry[] {
  const entries: CollectedToolSurfaceEntry[] = [];
  const names = new Set<string>();
  const append = (entry: CollectedToolSurfaceEntry): void => {
    if (assertUniqueNames) {
      assertUniqueToolName(
        entry.mountable.name,
        names.has(entry.mountable.name),
        duplicateLabel(transport),
      );
    }
    names.add(entry.mountable.name);
    entries.push(entry);
  };

  for (const service of surface.services ?? []) {
    for (const mountable of collectTools(service, transport, collectConfig)) {
      append({
        kind: 'contract',
        service: service.name,
        action: mountable.method.key,
        mountable,
      });
    }
  }

  for (const definition of surface.runtimeTools ?? []) {
    if (!runtimeToolSupports(definition, transport)) continue;
    append({
      kind: 'runtime',
      service: definition.identity.serviceName,
      action: definition.identity.action,
      mountable: runtimeToolMountable(definition, collectConfig.assertNames),
      definition,
    });
  }

  return entries;
}
