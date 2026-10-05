import type { ToolTransport } from '../contract/define';
import {
  type ProjectedTool,
  projectToolSurface,
  type ToolSurfaceProjection,
} from './internal/surface-projector';
import { type CollectToolsConfig, contractToolMountable, type MountableTool } from './mount';
import { runtimeToolMountable } from './runtime-tool';
import type { RuntimeToolDefinition } from './runtime-tool-declaration';

interface CollectedContractTool<TRuntime extends RuntimeToolDefinition> {
  kind: 'contract';
  service: string;
  action: string;
  mountable: MountableTool;
  projection: Extract<ProjectedTool<TRuntime>, { kind: 'contract' }>;
}

interface CollectedRuntimeTool<TRuntime extends RuntimeToolDefinition> {
  kind: 'runtime';
  service: string;
  action: string;
  mountable: MountableTool;
  definition: TRuntime;
  projection: Extract<ProjectedTool<TRuntime>, { kind: 'runtime' }>;
}

export type CollectedToolSurfaceEntry<
  TRuntime extends RuntimeToolDefinition = RuntimeToolDefinition,
> = CollectedContractTool<TRuntime> | CollectedRuntimeTool<TRuntime>;

export interface CollectToolSurfaceConfig<
  TRuntime extends RuntimeToolDefinition = RuntimeToolDefinition,
> extends CollectToolsConfig {
  surface: ToolSurfaceProjection<TRuntime>;
  transport: ToolTransport;
  /** Diagnostics disable this so they can report a broken surface. Default: true. */
  assertUniqueNames?: boolean;
}

/**
 * Resolve contracts and runtime definitions in their real mount order through
 * the same name, exposure and presentation-schema machinery as the mounts.
 */
export function collectToolSurface<TRuntime extends RuntimeToolDefinition>({
  surface,
  transport,
  assertUniqueNames = true,
  ...collectConfig
}: CollectToolSurfaceConfig<TRuntime>): CollectedToolSurfaceEntry<TRuntime>[] {
  const entries: CollectedToolSurfaceEntry<TRuntime>[] = [];
  const append = (entry: CollectedToolSurfaceEntry<TRuntime>): void => {
    entries.push(entry);
  };

  for (const projected of projectToolSurface<TRuntime>(surface, transport, {
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
