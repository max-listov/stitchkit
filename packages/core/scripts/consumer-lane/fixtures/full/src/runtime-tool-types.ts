import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ToolSet } from 'ai';
import { createDeferredAgentToolSurface } from 'stitchkit/agent-runtime';
import {
  type CliConfig,
  type CliInvokerConfig,
  createCli,
  createCliInvoker,
} from 'stitchkit/cli';
import {
  type AgentToolModelOutput,
  createRuntimeToolFactory,
  defineRuntimeTool,
  mountAgentTools,
  type RuntimeMcpPresentation,
  type RuntimeToolDefinition,
  type RuntimeToolDefinitionWithOutput,
  type RuntimeToolPresenters,
} from 'stitchkit/tools';
import { mountAgent } from 'stitchkit/tools/agent';
import { z } from 'zod';

const input = z.object({ text: z.string() });
const output = z.object({ size: z.number() });
const definition = defineRuntimeTool({
  name: 'measure',
  description: 'Typed SDK presenters',
  identity: { serviceName: 'probe', action: 'measure', method: 'POST' },
  expose: ['CLI', 'MCP', 'AGENT'],
  input,
  output,
  handler: ({ input }) => ({ size: input.text.length }),
  present: {
    mcp: (value) => ({ content: [{ type: 'text', text: String(value.size) }] }),
    agent: (value) => ({ type: 'text', value: String(value.size) }),
  },
});
const typed: RuntimeToolDefinitionWithOutput<
  typeof input,
  typeof output,
  undefined,
  RuntimeToolPresenters<z.output<typeof output>>
> = definition;
const cli: CliConfig = {
  name: 'sdk-cli',
  version: '1',
  access: { open: 'local-operator' },
  runtimeTools: [typed],
};
const invoker: CliInvokerConfig<{ id: string }> = {
  name: 'sdk-invoker',
  access: { open: 'local-operator' },
  auth: { id: 'local' },
  runtimeTools: () => [typed],
};
void createCli(cli);
void createCliInvoker(invoker);
void mountAgent([], { access: { open: 'local-operator' }, runtimeTools: [typed] });
void mountAgentTools([], { access: { open: 'local-operator' }, runtimeTools: [typed] });
// A registered list is the deferred Agent surface's catalog without a conversion.
const catalog: readonly RuntimeToolDefinition[] = [typed];
void createDeferredAgentToolSurface({
  runtimeTools: catalog,
  search: { name: 'tool_search', maxQueryBytes: 10, maxResults: 1, maxResultBytes: 512 },
  activation: { maxSelectedTools: 1, maxActiveTools: 2, maxSchemaBytes: 1_000 },
});
const sdkMcp = { content: [{ type: 'text', text: 'hello' }] } satisfies CallToolResult;
const mcp: RuntimeMcpPresentation = sdkMcp;
const model: AgentToolModelOutput = { type: 'text', value: 'hello' };
const sdkTools: ToolSet = mountAgent([], {
  access: { open: 'local-operator' },
  runtimeTools: [typed],
});
void sdkMcp;
void mcp;
void model;
void sdkTools;
// @ts-expect-error MCP SDK text content requires text, not a number.
const malformedMcp: CallToolResult = { content: [{ type: 'text', text: 1 }] };
// @ts-expect-error The shared framework presenter preserves SDK content types.
const malformedPresentation: RuntimeMcpPresentation = { content: [{ type: 'text', text: 1 }] };
// @ts-expect-error The shared framework presenter preserves required SDK content.
const missingPresentation: RuntimeMcpPresentation = {};
// @ts-expect-error The shared framework presenter preserves SDK metadata types.
const malformedMetadata: RuntimeMcpPresentation = { content: [], _meta: 42 };
// @ts-expect-error The framework owns MCP validation/error fields.
const reservedMcp: RuntimeMcpPresentation = { content: [], isError: true };
// @ts-expect-error An AgentToolModelOutput text result requires a string value.
const malformedAgent: AgentToolModelOutput = { type: 'text', value: 1 };
void malformedMcp;
void malformedPresentation;
void missingPresentation;
void malformedMetadata;
void reservedMcp;
void malformedAgent;

const extraInput = z.object({ text: z.string(), requiredExtra: z.string() });
const tooNarrow: RuntimeToolDefinitionWithOutput<typeof extraInput, typeof output>['handler'] =
  ({ input }) => ({
    size: input.requiredExtra.length,
  });
const invalidDefinition: RuntimeToolDefinitionWithOutput<
  typeof input,
  typeof output,
  undefined,
  RuntimeToolPresenters<z.output<typeof output>>
> = {
  ...definition,
  // @ts-expect-error A pretyped callback cannot require fields the declared schema omits.
  handler: tooNarrow,
};
// @ts-expect-error A pretyped callback is also rejected by the public constructor.
defineRuntimeTool({ ...definition, handler: tooNarrow });
// @ts-expect-error Wrong declared output remains rejected at construction.
const wrongOutput: typeof definition.handler = () => ({ size: 'wrong' });
void invalidDefinition;
void wrongOutput;

defineRuntimeTool({
  name: 'confirmed_measure',
  description: 'Typed MCP input round',
  identity: { serviceName: 'probe', action: 'confirmed', method: 'POST' },
  input,
  output,
  mcp: {
    inputRequired: [
      {
        key: 'confirmation',
        message: 'Confirm',
        schema: z.object({ confirmed: z.boolean() }),
      },
    ],
  },
  handler: ({ input, mcpInput }) => {
    const confirmed: boolean | undefined = mcpInput?.confirmation.confirmed;
    // @ts-expect-error MCP elicitation fields retain their schema types.
    const wrongConfirmation: string | undefined = mcpInput?.confirmation.confirmed;
    void confirmed;
    void wrongConfirmation;
    return { size: input.text.length };
  },
});

const factory = createRuntimeToolFactory({
  serviceName: 'probe',
  context: z.object({ owner: z.string() }),
});
factory.define({
  name: 'context_probe',
  action: 'contextProbe',
  method: 'GET',
  description: 'Typed context',
  input,
  output,
  handler: ({ owner, input, mcp }) => {
    const identity: string = owner;
    const text: string = input.text;
    const name: string | undefined = mcp?.clientInfo?.name;
    void identity;
    void name;
    // @ts-expect-error Context fields keep their declared type.
    const wrongOwner: number = owner;
    void wrongOwner;
    return { size: text.length };
  },
});
