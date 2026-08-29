import type { ToolCallRepairFunction, ToolSet } from 'ai';
import { executableAgentRuntimeTools } from '../internal/typed';
import { mountAgent } from '../tools/agent';
import { buildToolManifest } from '../tools/manifest';
import { AgentContextOverflowError } from './context-refusal';
import { createDeferredSearchTool, placeholderDeferredSearch } from './deferred-tool-search';
import {
  latestSelection,
  positive,
  schemaBytes,
  uniqueKnown,
  utf8Bytes,
} from './deferred-tool-selection';
import type {
  DeferredAgentToolController,
  DeferredAgentToolSurfaceConfig,
  DeferredAgentToolSurfaceDefinition,
  DeferredResolvedSurface,
} from './deferred-tool-types';
import {
  deferredToolCatalog,
  registerDeferredToolCatalog,
  registerDeferredToolRepair,
  repairedSearchCall,
} from './deferred-tools-internal';
import type { AgentRuntimePrepareStep, AgentRuntimeRunContext } from './runtime';

export * from './deferred-tool-types';

function configuredSurfaces<CONTEXT>(
  config: DeferredAgentToolSurfaceConfig<CONTEXT>,
): Readonly<Record<string, DeferredAgentToolSurfaceDefinition>> {
  return 'surfaces' in config ? config.surfaces : { default: config };
}

function resolveSurface<CONTEXT>(
  config: DeferredAgentToolSurfaceConfig<CONTEXT>,
  surfaces: ReadonlyMap<string, DeferredResolvedSurface>,
  runContext: AgentRuntimeRunContext<CONTEXT>,
): DeferredResolvedSurface {
  const key = 'surfaces' in config ? config.selectSurface(runContext) : 'default';
  const surface = surfaces.get(key);
  if (!surface) throw new Error(`Unknown deferred Agent tool surface "${key}"`);
  return surface;
}

function resolveAllSurfaces<CONTEXT>(
  config: DeferredAgentToolSurfaceConfig<CONTEXT>,
): Map<string, DeferredResolvedSurface> {
  const placeholderSearch = placeholderDeferredSearch(config.search.name);
  const surfaces = new Map<string, DeferredResolvedSurface>();
  for (const [key, definition] of Object.entries(configuredSurfaces(config))) {
    const runtimeTools = executableAgentRuntimeTools(definition.runtimeTools ?? []);
    const fullManifest = buildToolManifest({
      ...definition,
      runtimeTools: [...runtimeTools, placeholderSearch],
      transport: 'AGENT',
    });
    const searchEntry = fullManifest.find((entry) => entry.name === config.search.name);
    if (!searchEntry)
      throw new Error(`Search tool "${config.search.name}" is not Agent-exposed`);
    const manifest = fullManifest.filter((entry) => entry.name !== config.search.name);
    const byName = new Map(manifest.map((entry) => [entry.name, entry]));
    const provisional: DeferredResolvedSurface = {
      key,
      definition,
      manifest,
      byName,
      searchEntry,
      alwaysOn: [],
    };
    const alwaysOn = uniqueKnown(definition.alwaysOn ?? [], provisional);
    if (alwaysOn.rejected > 0)
      throw new Error(`Surface "${key}" has an unknown or duplicate alwaysOn tool`);
    surfaces.set(key, { ...provisional, alwaysOn: alwaysOn.names });
  }
  if (surfaces.size === 0)
    throw new Error('Deferred Agent tool surface registry must not be empty');
  return surfaces;
}

function assertConstructionBudgets<CONTEXT>(
  config: DeferredAgentToolSurfaceConfig<CONTEXT>,
  surfaces: ReadonlyMap<string, DeferredResolvedSurface>,
): void {
  for (const surface of surfaces.values()) {
    const base = [...surface.alwaysOn, config.search.name];
    if (base.length > config.activation.maxActiveTools) {
      throw new Error(`Surface "${surface.key}" base tools exceed maxActiveTools`);
    }
    if (schemaBytes(base, surface) > config.activation.maxSchemaBytes) {
      throw new Error(`Surface "${surface.key}" base tools exceed maxSchemaBytes`);
    }
  }
  const minimumReceipt = {
    schemaVersion: 1,
    kind: 'stitchkit.deferred-tool-selection',
    status: 'NO_MATCH',
    runId: 'run',
    surfaceKey: 'surface',
    selected: [],
    matches: [],
    truncated: false,
  };
  if (config.search.maxResultBytes < utf8Bytes(minimumReceipt)) {
    throw new Error('search.maxResultBytes cannot contain the minimum search receipt');
  }
}

function assertActiveBudget<CONTEXT>(
  config: DeferredAgentToolSurfaceConfig<CONTEXT>,
  names: readonly string[],
  surface: DeferredResolvedSurface,
): number {
  if (names.length > config.activation.maxActiveTools) {
    throw new AgentContextOverflowError('Deferred Agent active-tool ceiling exceeded');
  }
  const bytes = schemaBytes(names, surface);
  if (bytes > config.activation.maxSchemaBytes) {
    throw new AgentContextOverflowError('Deferred Agent schema-byte ceiling exceeded');
  }
  return bytes;
}

export function createDeferredAgentToolSurface<CONTEXT>(
  config: DeferredAgentToolSurfaceConfig<CONTEXT>,
): DeferredAgentToolController<CONTEXT> {
  positive('search.maxQueryBytes', config.search.maxQueryBytes);
  positive('search.maxResults', config.search.maxResults);
  positive('search.maxResultBytes', config.search.maxResultBytes);
  positive('activation.maxSelectedTools', config.activation.maxSelectedTools);
  positive('activation.maxActiveTools', config.activation.maxActiveTools);
  positive('activation.maxSchemaBytes', config.activation.maxSchemaBytes);
  const surfaces = resolveAllSurfaces(config);
  assertConstructionBudgets(config, surfaces);

  return {
    mount(runContext, mountConfig = {}) {
      const surface = resolveSurface(config, surfaces, runContext);
      const runtimeTools = [
        ...executableAgentRuntimeTools(surface.definition.runtimeTools ?? []),
        createDeferredSearchTool(config, runContext, surface),
      ];
      const tools = mountAgent([...(surface.definition.services ?? [])], {
        ...mountConfig,
        runtimeTools,
      });
      registerDeferredToolCatalog(tools, config.search.name, new Set(surface.byName.keys()));
      return tools;
    },
    prepareStep(applicationPrepareStep) {
      const prepared: AgentRuntimePrepareStep<CONTEXT> = async (input) => {
        const application = await applicationPrepareStep?.(input);
        const surface = resolveSurface(config, surfaces, input);
        const selection = latestSelection(
          input.messages,
          config.search.name,
          input.run.id,
          surface,
          config.activation.maxSelectedTools,
        );
        const currentSelection = latestSelection(
          input.responseMessages,
          config.search.name,
          input.run.id,
          surface,
          config.activation.maxSelectedTools,
        );
        const pins = uniqueKnown(config.pins?.(input) ?? [], surface);
        if (pins.rejected > 0) {
          throw new AgentContextOverflowError(
            'Deferred Agent pins contain unknown or duplicate tools',
          );
        }
        const selected = uniqueKnown(selection.selected, surface);
        const names = uniqueKnown(
          [config.search.name, ...surface.alwaysOn, ...pins.names, ...selected.names],
          surface,
        ).names;
        if (!names.includes(config.search.name)) names.unshift(config.search.name);
        const bytes = assertActiveBudget(config, names, surface);
        config.observe?.({
          schemaVersion: 1,
          type: 'step',
          runId: input.run.id,
          surfaceKey: surface.key,
          catalogTools: surface.manifest.length,
          baseTools: surface.alwaysOn.length + 1,
          pinnedTools: pins.names.length,
          selectedTools: selected.names.length,
          activeTools: names.length,
          activeSchemaBytes: bytes,
          rejectedNames: selected.rejected,
          replacementTools: selected.names.length,
          source: currentSelection.source === 'durable' ? 'current' : selection.source,
        });
        return { ...application, activeTools: names };
      };
      const repair: ToolCallRepairFunction<ToolSet> = async ({ toolCall, tools, error }) => {
        const catalog = deferredToolCatalog(tools, config.search.name);
        if (
          !('toolName' in error) ||
          !catalog?.has(toolCall.toolName) ||
          toolCall.toolName in tools
        ) {
          return null;
        }
        return repairedSearchCall(toolCall, config.search.name);
      };
      registerDeferredToolRepair(prepared, repair);
      return prepared;
    },
  };
}
