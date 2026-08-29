import type { z } from 'zod';
import {
  defineRuntimeTool,
  type RuntimeToolDefinitionWithOutput,
} from '../tools/runtime-tool';
import { AgentContextOverflowError } from './context-refusal';
import { ranked, schemaBytes, uniqueKnown, utf8Bytes } from './deferred-tool-selection';
import {
  type DeferredAgentToolCommonConfig,
  type DeferredAgentToolMatchSchema,
  type DeferredAgentToolReceipt,
  DeferredAgentToolReceiptSchema,
  DeferredAgentToolSearchInputSchema,
  type DeferredResolvedSurface,
} from './deferred-tool-types';
import type { AgentRuntimeRunContext } from './runtime';

type SearchDefinition = RuntimeToolDefinitionWithOutput<
  typeof DeferredAgentToolSearchInputSchema,
  typeof DeferredAgentToolReceiptSchema
>;
const description =
  'Search the available tool catalog and select exact tools for the next step.';

export function placeholderDeferredSearch(name: string): SearchDefinition {
  return defineRuntimeTool({
    name,
    description,
    identity: { serviceName: 'agent-runtime', action: 'deferred-tool-search', method: 'POST' },
    input: DeferredAgentToolSearchInputSchema,
    output: DeferredAgentToolReceiptSchema,
    transports: ['AGENT'],
    handler: (): DeferredAgentToolReceipt => ({
      schemaVersion: 1,
      kind: 'stitchkit.deferred-tool-selection',
      status: 'NO_MATCH',
      runId: 'construction',
      surfaceKey: 'construction',
      selected: [],
      matches: [],
      truncated: false,
    }),
  });
}

export function createDeferredSearchTool<CONTEXT>(
  config: DeferredAgentToolCommonConfig<CONTEXT>,
  runContext: AgentRuntimeRunContext<CONTEXT>,
  surface: DeferredResolvedSurface,
): SearchDefinition {
  return defineRuntimeTool({
    name: config.search.name,
    description,
    identity: { serviceName: 'agent-runtime', action: 'deferred-tool-search', method: 'POST' },
    input: DeferredAgentToolSearchInputSchema,
    output: DeferredAgentToolReceiptSchema,
    transports: ['AGENT'],
    handler: async ({ input }): Promise<DeferredAgentToolReceipt> => {
      const queryOversized = utf8Bytes(input.query) > config.search.maxQueryBytes;
      const proposed = queryOversized
        ? []
        : input.reason === 'inactive_call'
          ? [input.query]
          : config.search.select
            ? await config.search.select({
                query: input.query,
                manifest: surface.manifest,
                context: runContext.context,
                runId: runContext.run.id,
                surfaceKey: surface.key,
              })
            : ranked(input.query, surface.manifest);
      const known = uniqueKnown(proposed, surface);
      const selected = known.names.slice(0, config.search.maxResults);
      const candidateActive = [config.search.name, ...surface.alwaysOn, ...selected];
      const refused =
        queryOversized ||
        selected.length > config.activation.maxSelectedTools ||
        candidateActive.length > config.activation.maxActiveTools ||
        schemaBytes(candidateActive, surface) > config.activation.maxSchemaBytes;
      const admitted = refused ? [] : selected;
      const matches: Array<z.infer<typeof DeferredAgentToolMatchSchema>> = [];
      let truncated = known.names.length > selected.length;
      for (const name of selected) {
        const entry = surface.byName.get(name);
        if (!entry) continue;
        const next = [...matches, { name, description: entry.description }];
        if (
          utf8Bytes({
            schemaVersion: 1,
            kind: 'stitchkit.deferred-tool-selection',
            status: 'SELECTED',
            runId: runContext.run.id,
            surfaceKey: surface.key,
            selected: admitted,
            matches: next,
            truncated,
          }) > config.search.maxResultBytes
        ) {
          truncated = true;
          break;
        }
        matches.push({ name, description: entry.description });
      }
      const status = refused
        ? 'SELECTION_REFUSED'
        : input.reason === 'inactive_call' && admitted.length > 0
          ? 'SEARCH_REQUIRED'
          : admitted.length > 0
            ? 'SELECTED'
            : 'NO_MATCH';
      let receipt: DeferredAgentToolReceipt = {
        schemaVersion: 1,
        kind: 'stitchkit.deferred-tool-selection',
        status,
        runId: runContext.run.id,
        surfaceKey: surface.key,
        selected: admitted,
        matches,
        truncated,
      };
      if (utf8Bytes(receipt) > config.search.maxResultBytes) {
        receipt = {
          schemaVersion: 1,
          kind: 'stitchkit.deferred-tool-selection',
          status: 'SELECTION_REFUSED',
          runId: runContext.run.id,
          surfaceKey: surface.key,
          selected: [],
          matches: [],
          truncated: true,
        };
      }
      if (utf8Bytes(receipt) > config.search.maxResultBytes) {
        throw new AgentContextOverflowError(
          'Deferred Agent search receipt exceeds its byte ceiling',
        );
      }
      config.observe?.({
        schemaVersion: 1,
        type: 'search',
        runId: runContext.run.id,
        surfaceKey: surface.key,
        catalogTools: surface.manifest.length,
        baseTools: surface.alwaysOn.length + 1,
        pinnedTools: 0,
        selectedTools: receipt.selected.length,
        activeTools: surface.alwaysOn.length + receipt.selected.length + 1,
        activeSchemaBytes: schemaBytes(
          [config.search.name, ...surface.alwaysOn, ...receipt.selected],
          surface,
        ),
        rejectedNames: known.rejected,
        replacementTools: receipt.selected.length,
        source: 'current',
      });
      return receipt;
    },
  });
}
