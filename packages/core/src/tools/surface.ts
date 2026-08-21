import type { Transport } from '../contract';
import type { ServiceDef } from '../server/types';
import { type ProjectedTool, projectToolSurface } from './internal/surface-projector';
import { type CollectToolsConfig, contractToolMountable, type MountableTool } from './mount';
import { type RuntimeToolDefinition, runtimeToolMountable } from './runtime-tool';

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
  projection: Extract<ProjectedTool<RuntimeToolDefinition>, { kind: 'contract' }>;
}

interface CollectedRuntimeTool {
  kind: 'runtime';
  service: string;
  action: string;
  mountable: MountableTool;
  definition: RuntimeToolDefinition;
  projection: Extract<ProjectedTool<RuntimeToolDefinition>, { kind: 'runtime' }>;
}

export type CollectedToolSurfaceEntry = CollectedContractTool | CollectedRuntimeTool;

export interface CollectToolSurfaceConfig extends CollectToolsConfig {
  surface: ToolSurfaceDefinition;
  transport: ToolSurfaceTransport;
  /** Diagnostics disable this so they can report a broken surface. Default: true. */
  assertUniqueNames?: boolean;
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
  const append = (entry: CollectedToolSurfaceEntry): void => {
    entries.push(entry);
  };

  for (const projected of projectToolSurface<RuntimeToolDefinition>(surface, transport, {
    extend: collectConfig.extend,
    flattenUnionInput: collectConfig.flattenUnionInput,
    assertNames: collectConfig.assertNames,
    assertUniqueNames,
  })) {
    if (projected.kind === 'contract') {
      const mountable = contractToolMountable(projected, collectConfig.extend);
      append({
        kind: 'contract',
        service: projected.serviceName,
        action: mountable.method.key,
        mountable,
        projection: projected,
      });
    } else {
      append({
        kind: 'runtime',
        service: projected.serviceName,
        action: projected.action,
        mountable: runtimeToolMountable(projected.source, false),
        definition: projected.source,
        projection: projected,
      });
    }
  }

  return entries;
}
