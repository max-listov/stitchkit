import type { ToolTransport } from '../contract/define';
import {
  type ProjectedTool,
  projectToolSurface,
  type ToolSurfaceProjection,
} from './internal/surface-projector';
import { type CollectToolsConfig, contractToolMountable, type MountableTool } from './mount';
import { type RuntimeToolDefinition, runtimeToolMountable } from './runtime-tool';
import type { RuntimeToolExecution } from './runtime-tool-execution';

/** Contract and pathless runtime operations that form one tool surface. */
export interface ToolSurfaceDefinition<
  TRuntime extends RuntimeToolExecution = RuntimeToolDefinition,
> extends ToolSurfaceProjection<TRuntime> {}

interface CollectedContractTool<TRuntime extends RuntimeToolExecution> {
  kind: 'contract';
  service: string;
  action: string;
  mountable: MountableTool;
  projection: Extract<ProjectedTool<TRuntime>, { kind: 'contract' }>;
}

interface CollectedRuntimeTool<TRuntime extends RuntimeToolExecution> {
  kind: 'runtime';
  service: string;
  action: string;
  mountable: MountableTool;
  definition: TRuntime;
  projection: Extract<ProjectedTool<TRuntime>, { kind: 'runtime' }>;
}

export type CollectedToolSurfaceEntry<
  TRuntime extends RuntimeToolExecution = RuntimeToolDefinition,
> = CollectedContractTool<TRuntime> | CollectedRuntimeTool<TRuntime>;

export interface CollectToolSurfaceConfig<
  TRuntime extends RuntimeToolExecution = RuntimeToolDefinition,
> extends CollectToolsConfig {
  surface: ToolSurfaceDefinition<TRuntime>;
  transport: ToolTransport;
  /** Diagnostics disable this so they can report a broken surface. Default: true. */
  assertUniqueNames?: boolean;
}

/**
 * Resolve contracts and runtime definitions in their real mount order through
 * the same name, exposure and presentation-schema machinery as the mounts.
 */
export function collectToolSurface<TRuntime extends RuntimeToolExecution>({
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
