import type { CallToolResult } from '@modelcontextprotocol/server';
import {
  buildMcpServer,
  createMcpHandler,
  createMcpHttpRoute,
  type McpHandlerConfig,
  type McpSurfaceDefinition,
  type RuntimeMcpPresentation,
  type RuntimeMcpToolDefinition,
  type RuntimeMcpToolDefinitionWithOutput,
} from 'stitchkit/tools/mcp';
import { z } from 'zod';

const input = z.object({ value: z.number() });
const output = z.object({ doubled: z.number() });
type Definition = RuntimeMcpToolDefinitionWithOutput<typeof input, typeof output>;
const definition = {
  name: 'double',
  description: 'Double a number',
  identity: { serviceName: 'numbers', action: 'double', method: 'POST' },
  input,
  output,
  handler: ({ input }) => ({ doubled: input.value * 2 }),
  present: { mcp: ({ doubled }) => ({ content: [{ type: 'text', text: `${doubled}` }] }) },
} satisfies Definition;
const registered: RuntimeMcpToolDefinition = definition;
const surface: McpSurfaceDefinition = { services: [], runtimeTools: [registered] };
const config: McpHandlerConfig<{ id: string }> = {
  serverInfo: { name: 'strict-mcp-only', version: '1' },
  ...surface,
  auth: () => ({ id: 'reader' }),
};
const handler = createMcpHandler(config);
const route = createMcpHttpRoute({ path: '/mcp', handler });
const server = buildMcpServer(config, { id: 'reader' });
const sdkResult: CallToolResult = { content: [] };
void route;
void server;
void sdkResult;

// @ts-expect-error The output schema retains its numeric field.
const wrongHandler: Definition['handler'] = () => ({ doubled: 'wrong' });
// @ts-expect-error The official SDK requires a string content-block discriminator.
const wrongContent: RuntimeMcpPresentation = { content: [{ type: 42, text: '' }] };
// @ts-expect-error MCP presentations retain the SDK's required content field.
const missingContent: RuntimeMcpPresentation = {};
// @ts-expect-error SDK metadata must be an object.
const wrongMetadata: RuntimeMcpPresentation = { content: [], _meta: 42 };
// @ts-expect-error A known SDK text content block requires string text.
const wrongText: RuntimeMcpPresentation = { content: [{ type: 'text', text: 42 }] };
// @ts-expect-error Presenters cannot override framework error state.
const wrongErrorState: RuntimeMcpPresentation = { content: [], isError: true };
// @ts-expect-error A typed presenter receives the concrete declared output.
const wrongPresenter: NonNullable<Definition['present']>['mcp'] = ({
  missing,
}: {
  missing: boolean;
}) => ({ content: [{ type: 'text', text: String(missing) }] });
// @ts-expect-error Erased registration cannot be invoked without canonical schema parsing.
registered.handler({ input: { value: 1 } });
void wrongHandler;
void wrongContent;
void missingContent;
void wrongMetadata;
void wrongText;
void wrongErrorState;
void wrongPresenter;
