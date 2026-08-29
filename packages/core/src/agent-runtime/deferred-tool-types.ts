import type { ToolSet } from 'ai';
import { type ZodObject, type ZodType, z } from 'zod';
import type { EndpointToolAnnotations, EndpointUiMeta, HttpMethod } from '../contract';
import type { ServiceDef } from '../server/types';
import type { ErrorHintFn, ToolCallHooks, ToolLifecycle } from '../tools/execute';
import type { ToolExtend } from '../tools/mount';
import type { AgentRuntimePrepareStep, AgentRuntimeRunContext } from './runtime';

export const DeferredAgentToolSearchInputSchema = z.object({
  query: z.string().min(1),
  reason: z.enum(['inactive_call']).optional(),
});
export const DeferredAgentToolMatchSchema = z.object({
  name: z.string(),
  description: z.string(),
});
export const DeferredAgentToolReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('stitchkit.deferred-tool-selection'),
    status: z.enum(['SELECTED', 'SEARCH_REQUIRED', 'NO_MATCH', 'SELECTION_REFUSED']),
    runId: z.string(),
    surfaceKey: z.string(),
    selected: z.array(z.string()),
    matches: z.array(DeferredAgentToolMatchSchema),
    truncated: z.boolean(),
  })
  .superRefine((receipt, context) => {
    const selected = receipt.status === 'SELECTED' || receipt.status === 'SEARCH_REQUIRED';
    if (selected !== receipt.selected.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['selected'],
        message: `${receipt.status} receipt has inconsistent selected tools`,
      });
    }
  });

export type DeferredAgentToolReceipt = z.infer<typeof DeferredAgentToolReceiptSchema>;
export interface DeferredAgentRuntimeToolDefinition {
  name: string;
  description: string;
  identity: {
    serviceName: string;
    action: string;
    method: HttpMethod;
    scope?: string;
    meta?: Record<string, unknown>;
  };
  input: ZodObject;
  output?: ZodType;
  transports?: readonly ('MCP' | 'AGENT' | 'CLI')[];
  annotations?: EndpointToolAnnotations;
  ui?: EndpointUiMeta;
  handler: unknown;
  present?: { agent?: unknown };
}
export interface DeferredAgentToolManifestEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface DeferredAgentToolMountConfig {
  context?: Record<string, unknown>;
  hooks?: ToolCallHooks;
  lifecycle?: ToolLifecycle;
  extend?: ToolExtend;
  coerceJsonArgs?: boolean;
  onOutputStrip?: (toolName: string, paths: string[]) => void;
  flattenUnionInput?: boolean;
  errorHint?: ErrorHintFn;
}
export interface DeferredAgentToolSurfaceDefinition {
  services?: readonly ServiceDef[];
  runtimeTools?: readonly DeferredAgentRuntimeToolDefinition[];
  alwaysOn?: readonly string[];
}
export interface DeferredAgentToolSearchContext<CONTEXT> {
  query: string;
  manifest: readonly DeferredAgentToolManifestEntry[];
  context: CONTEXT;
  runId: string;
  surfaceKey: string;
}
export interface DeferredAgentToolEvent {
  schemaVersion: 1;
  type: 'search' | 'step';
  runId: string;
  surfaceKey: string;
  catalogTools: number;
  baseTools: number;
  pinnedTools: number;
  selectedTools: number;
  activeTools: number;
  activeSchemaBytes: number;
  rejectedNames: number;
  replacementTools: number;
  source: 'catalog' | 'current' | 'durable';
}
export interface DeferredAgentToolCommonConfig<CONTEXT> {
  pins?(input: Parameters<AgentRuntimePrepareStep<CONTEXT>>[0]): readonly string[];
  search: {
    name: string;
    maxQueryBytes: number;
    maxResults: number;
    maxResultBytes: number;
    select?(
      input: DeferredAgentToolSearchContext<CONTEXT>,
    ): readonly string[] | Promise<readonly string[]>;
  };
  activation: {
    maxSelectedTools: number;
    maxActiveTools: number;
    maxSchemaBytes: number;
  };
  observe?(event: DeferredAgentToolEvent): void;
}
export type DeferredAgentToolSurfaceConfig<CONTEXT> = DeferredAgentToolCommonConfig<CONTEXT> &
  (
    | DeferredAgentToolSurfaceDefinition
    | {
        surfaces: Readonly<Record<string, DeferredAgentToolSurfaceDefinition>>;
        selectSurface(input: AgentRuntimeRunContext<CONTEXT>): string;
      }
  );
export interface DeferredResolvedSurface {
  key: string;
  definition: DeferredAgentToolSurfaceDefinition;
  manifest: readonly DeferredAgentToolManifestEntry[];
  byName: ReadonlyMap<string, DeferredAgentToolManifestEntry>;
  searchEntry: DeferredAgentToolManifestEntry;
  alwaysOn: readonly string[];
}
export interface DeferredAgentToolController<CONTEXT> {
  mount(
    runContext: AgentRuntimeRunContext<CONTEXT>,
    config?: DeferredAgentToolMountConfig,
  ): ToolSet;
  prepareStep(
    applicationPrepareStep?: AgentRuntimePrepareStep<CONTEXT>,
  ): AgentRuntimePrepareStep<CONTEXT>;
}
