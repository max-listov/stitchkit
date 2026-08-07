import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type CallToolResult, CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type {
  EndpointToolAnnotations,
  EndpointUiMeta,
  HttpMethod,
  RuntimeContext,
} from '../contract';
import { formatZodError } from '../internal/errors';
import { isRecord } from '../internal/typed';
import type { OperationIdentity } from '../server/types';
import {
  executeToolMethod,
  type ToolCallHooks,
  type ToolLifecycle,
  type ToolOperation,
} from './execute';
import type { PreparedMcpSurface } from './mcp';
import type { MountableTool } from './mount';
import { buildToolPresentationSchema, presentationMetadata } from './presentation';

export interface NativeMcpOperationIdentity {
  serviceName: string;
  action: string;
  scope?: string;
  /** Semantic operation verb for lifecycle and `RequestEvent.httpMethod`. */
  method: HttpMethod;
  /** Opaque project metadata exposed to lifecycle and tool hooks. */
  meta?: Record<string, unknown>;
}

export type NativeMcpHandlerContext<TInput extends z.ZodObject> = RuntimeContext & {
  params: undefined;
  input: z.output<TInput>;
};

export type NativeMcpResult<TOutput extends z.ZodObject | undefined = undefined> =
  TOutput extends z.ZodObject
    ? Omit<CallToolResult, 'structuredContent'> & {
        structuredContent: z.output<TOutput>;
      }
    : CallToolResult;

export interface NativeMcpToolDefinition<
  TInput extends z.ZodObject,
  TOutput extends z.ZodObject | undefined = undefined,
> {
  name: string;
  description: string;
  identity: NativeMcpOperationIdentity;
  input: TInput;
  output?: TOutput;
  annotations?: EndpointToolAnnotations;
  ui?: EndpointUiMeta;
  handler: (
    context: NativeMcpHandlerContext<TInput>,
  ) => NativeMcpResult<TOutput> | Promise<NativeMcpResult<TOutput>>;
}

export interface NativeMcpRegistrar {
  /** Register through stitchkit validation, lifecycle, context and tool hooks. */
  registerTool<
    TInput extends z.ZodObject,
    TOutput extends z.ZodObject | undefined = undefined,
  >(definition: NativeMcpToolDefinition<TInput, TOutput>): void;
  /**
   * Explicit SDK escape hatch. Registrations made here do not run stitchkit
   * validation, lifecycle, per-call context or tool hooks.
   */
  readonly rawServer: McpServer;
}

interface NativeMcpRuntimeConfig {
  context?: Record<string, unknown>;
  hooks?: ToolCallHooks;
  lifecycle?: ToolLifecycle;
  coerceJsonArgs?: boolean;
  onOutputStrip?: (toolName: string, paths: string[]) => void;
  prepare: (tool: MountableTool) => PreparedMcpSurface;
  formatError: (
    result: Extract<Awaited<ReturnType<typeof executeToolMethod>>, { ok: false }>,
    toolName: string,
  ) => CallToolResult;
}

function operationIdentity(
  definition: NativeMcpToolDefinition<z.ZodObject, z.ZodObject | undefined>,
): OperationIdentity {
  return {
    method: definition.identity.method,
    desc: definition.description,
    serviceName: definition.identity.serviceName,
    key: definition.identity.action,
    toolName: definition.name,
    scope: definition.identity.scope,
    meta: definition.identity.meta,
    annotations: definition.annotations,
    ui: definition.ui,
  };
}

function isCallToolResult(value: unknown): value is CallToolResult {
  return CallToolResultSchema.safeParse(value).success;
}

/** Validate the whole MCP envelope without replacing it, then parse structured output. */
function nativeResultSchema(output: z.ZodObject | undefined): z.ZodType {
  const envelope = z.custom<CallToolResult>(isCallToolResult, {
    error: 'Native MCP handler must return a valid CallToolResult',
  });
  if (!output) return envelope;
  return envelope.transform((result, context) => {
    const parsed = output.safeParse(result.structuredContent);
    if (!parsed.success) {
      context.addIssue({
        code: 'custom',
        message: `Invalid structuredContent: ${formatZodError(parsed.error)}`,
      });
      return z.NEVER;
    }
    return { ...result, structuredContent: parsed.data };
  });
}

/** Build the protected registrar for one fresh MCP server/runtime. */
export function createNativeMcpRegistrar(
  server: McpServer,
  config: NativeMcpRuntimeConfig,
): NativeMcpRegistrar {
  return {
    rawServer: server,
    registerTool: (definition) => {
      const identity = operationIdentity(definition);
      const advertisedOperation: ToolOperation = {
        ...identity,
        inputSchema: definition.input,
        outputSchema: definition.output,
        handler: () => undefined,
      };
      const mountable: MountableTool = {
        method: advertisedOperation,
        name: definition.name,
        argumentSchema: definition.input,
        presentationSchema: buildToolPresentationSchema({
          inputSchema: definition.input,
          unrepresentable: 'any',
        }),
        shouldExtend: false,
      };
      const [prepared] = config.prepare(mountable);
      if (!prepared) return;

      const executionOperation: ToolOperation = {
        ...identity,
        inputSchema: definition.input,
        outputSchema: nativeResultSchema(definition.output),
        handler: definition.handler,
      };

      const toolConfig: {
        description: string;
        inputSchema: z.ZodType;
        outputSchema?: z.ZodType;
        annotations?: EndpointToolAnnotations;
        _meta?: Record<string, unknown>;
      } = {
        description: definition.description,
        inputSchema: z.looseObject({}).meta(presentationMetadata(prepared.inputSchema)),
      };
      if (prepared.outputSchema) toolConfig.outputSchema = prepared.outputSchema;
      if (definition.annotations) toolConfig.annotations = definition.annotations;
      if (definition.ui) {
        toolConfig._meta = {
          ui: definition.ui,
          'ui/resourceUri': definition.ui.resourceUri,
        };
      }

      server.registerTool(definition.name, toolConfig, async (rawArgs) => {
        const args = isRecord(rawArgs) ? rawArgs : {};
        const result = await executeToolMethod(
          executionOperation,
          definition.name,
          args,
          { ...config.context, source: 'mcp' },
          config.hooks,
          config.lifecycle,
          config.coerceJsonArgs ?? true,
          config.onOutputStrip
            ? (paths) => config.onOutputStrip?.(definition.name, paths)
            : undefined,
        );
        if (!result.ok) return config.formatError(result, definition.name);
        if (isCallToolResult(result.data)) return result.data;
        return config.formatError(
          {
            ok: false,
            code: 'INTERNAL_SERVER_ERROR',
            details: { message: 'Native MCP handler returned an invalid result' },
          },
          definition.name,
        );
      });
    },
  };
}
