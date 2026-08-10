/**
 * A consumer that opted into the optional peers and mounts the tool surface.
 *
 * This is where the observability work of 0.30–0.32 has to be proved from the
 * outside: the hook that carries the cause of a failed tool call, and the audit
 * row that names it. Both were reported by a consuming project rather than
 * caught here, because in-repo tests call the executor directly — they never go
 * through a real mount, from an installed package, with the peer present.
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { QueryClient } from '@tanstack/react-query';
import { ApiError } from 'stitchkit';
import { defineContract, defineErrors } from 'stitchkit/contract';
import { createObservability, type RequestEvent } from 'stitchkit/observability';
import { createEntityCacheHandlers, type EntityCacheEvent } from 'stitchkit/react';
import { implement } from 'stitchkit/server';
import {
  buildMcpServer,
  buildToolManifest,
  createCli,
  createMcpHandler,
  createMcpHttpRoute,
  createToolInvoker,
  defineRuntimeTool,
  type ErrorHintFn,
  EXT_APPS_BUNDLE_PLACEHOLDER,
  flattenToolJsonSchema,
  inlineMcpAppBundle,
  listToolNames,
  mountAgent,
  RESOURCE_MIME_TYPE,
  summarizeTransports,
  type ToolCallContext,
  type ToolCallHooks,
  type ToolLifecycle,
  type ToolPresentationSchema,
  type ToolResult,
  validateMcpSchemas,
} from 'stitchkit/tools';
import { z } from 'zod';

declare const process: {
  env: Record<string, string | undefined>;
  execPath: string;
  exit(code: number): never;
};

let failures = 0;
function check(what: string, ok: boolean, detail?: unknown): void {
  if (ok) return;
  failures += 1;
  console.error(`  ✗ ${what}`, detail === undefined ? '' : detail);
}

const packedApiError = new ApiError(
  'CONFLICT',
  409,
  undefined,
  undefined,
  undefined,
  'packed-trace-id',
);
check(
  'the packed root ApiError exposes its response trace id',
  packedApiError.traceId === 'packed-trace-id',
);
if (process.env.STITCHKIT_COMPILE_REMOVED_API) {
  // @ts-expect-error ApiError response correlation is readonly for consumers.
  packedApiError.traceId = 'replacement';
}

const packedErrors = defineErrors({
  QUOTA_EXCEEDED: {
    status: 429,
    details: z.object({ retryAfterSeconds: z.number().positive() }),
  },
});
const packedError = packedErrors.errors.QUOTA_EXCEEDED({
  details: { retryAfterSeconds: 30 },
});
check(
  'the packed domain error factory preserves status and typed details',
  packedError.status === 429 && packedError.details.retryAfterSeconds === 30,
);

const presentation: ToolPresentationSchema = flattenToolJsonSchema(
  z.toJSONSchema(
    z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a'), value: z.string() }),
      z.object({ kind: z.literal('b'), count: z.number() }),
    ]),
    { io: 'input' },
  ),
);
check(
  'the packed presentation compiler exposes one object without executable Zod',
  presentation.type === 'object' && !('oneOf' in presentation),
);

const widgets = defineContract(
  { prefix: 'widgets' },
  {
    update: {
      method: 'POST',
      path: '/:id',
      desc: 'Update a widget',
      params: z.object({ id: z.string() }),
      input: z.object({ name: z.string() }),
      output: z.object({ id: z.string() }),
      expose: ['AGENT', 'CLI'],
      toolName: 'update_widget',
    },
  },
);

const thrown = new Error('ECONNREFUSED 10.0.0.4:5432');

const service = implement(widgets, {
  update: (ctx) => {
    if (ctx.params.id === 'boom') throw thrown;
    return { id: ctx.params.id };
  },
});

const signedWebhook = defineContract(
  { prefix: 'signed-webhook' },
  {
    receive: {
      method: 'POST',
      path: '/',
      desc: 'Receive signed webhook',
      rawBody: true,
      input: z.object({ event: z.string() }),
      output: z.object({ rawLength: z.number() }),
    },
  },
);
implement(signedWebhook, {
  receive: (context) => {
    const rawBody: string = context.rawBody;
    const request: Request = context.req;
    void request;
    return { rawLength: rawBody.length };
  },
});

const packedMultiRound = defineContract(
  { prefix: 'approval', scope: 'admin' },
  {
    approve: {
      method: 'POST',
      path: '/',
      desc: 'Approve with ordered typed input',
      expose: ['MCP'],
      output: z.object({ approved: z.boolean(), reason: z.string() }),
      mcp: {
        inputRequired: [
          {
            key: 'confirmation',
            message: 'Approve?',
            schema: z.object({ approved: z.boolean() }),
          },
          {
            key: 'reason',
            message: 'Reason?',
            schema: z.object({ value: z.string() }),
          },
        ],
      },
    },
  },
);
implement(packedMultiRound, {
  approve: ({ mcpInput }) => ({
    approved: mcpInput?.confirmation.approved ?? false,
    reason: mcpInput?.reason.value ?? '',
  }),
});

const NativeInputSchema = z.object({ id: z.string() });
const NativeOutputSchema = z.object({ updated: z.boolean() });
const packedResourceUri = 'ui://consumer/native-update.html';
const nativeDefinition = defineRuntimeTool({
  name: 'native_update',
  description: 'Update through native MCP content',
  identity: {
    serviceName: 'nativeWidgets',
    action: 'update',
    scope: 'admin',
    method: 'PATCH',
  },
  input: NativeInputSchema,
  output: NativeOutputSchema,
  ui: { resourceUri: packedResourceUri },
  handler: ({ input }) => ({ updated: input.id.length > 0 }),
  present: {
    mcp: (output) => ({
      content: [{ type: 'text', text: output.updated ? 'updated' : 'unchanged' }],
    }),
    agent: (output) => ({ type: 'json', value: output }),
  },
});

const packedNativeServer = buildMcpServer(
  {
    serverInfo: { name: 'consumer', version: '1' },
    services: [],
    runtimeTools: [nativeDefinition],
  },
  undefined,
);
check('the packed MCP surface accepts a typed runtime definition', !!packedNativeServer);
let rawMounted = false;
buildMcpServer(
  {
    serverInfo: { name: 'consumer-raw', version: '1' },
    services: [],
    rawTools: () => {
      rawMounted = true;
    },
  },
  undefined,
);
check('the packed rawTools escape hatch remains explicit', rawMounted);
check(
  'the packed Agent mount accepts the same runtime definition',
  typeof mountAgent([], { runtimeTools: [nativeDefinition] }).native_update?.execute ===
    'function',
);
const packedSurface = { services: [service], runtimeTools: [nativeDefinition] };
const packedInvoker = createToolInvoker(service, { transport: 'AGENT' });
check(
  'the packed in-process invoker runs the canonical contract tool',
  JSON.stringify(
    await packedInvoker.invokeOrThrow('update_widget', { id: 'invoked', name: 'x' }),
  ) === JSON.stringify({ id: 'invoked' }),
);
let cliVersion = '';
await createCli({
  name: 'packed-cli',
  version: '1',
  services: [service],
  argv: ['--version'],
  stdout: (text) => {
    cliVersion += text;
  },
  exit: () => undefined,
});
check('the packed CLI entrypoint executes', cliVersion === 'packed-cli 1\n');
check(
  'the packed manifest includes contract and runtime tools without a local schema walker',
  buildToolManifest({ ...packedSurface, transport: 'AGENT' }).length === 2,
);
check(
  'the packed name snapshot carries the runtime origin',
  listToolNames(packedSurface).some(
    (entry) => entry.kind === 'runtime' && entry.name === 'native_update',
  ),
);
check(
  'the packed transport summary counts the runtime definition',
  summarizeTransports(packedSurface).runtimeTools === 1,
);

interface PackedEntity {
  id: string;
  workspaceId: string;
  label: string;
  internal: string;
}
interface PackedListItem {
  id: string;
  label: string;
}
function packedWorkspace(event: EntityCacheEvent<PackedEntity>): string {
  if (event.type !== 'deleted') return event.entity.workspaceId;
  if ('workspaceId' in event.payload && typeof event.payload.workspaceId === 'string') {
    return event.payload.workspaceId;
  }
  throw new Error('A scoped delete must carry its entity');
}
const packedQueryClient = new QueryClient();
packedQueryClient.setQueryData<PackedListItem[]>(['workspace', 'w1', 'entities'], []);
const packedCache = createEntityCacheHandlers<PackedEntity, PackedListItem>({
  getId: (entity) => entity.id,
  getListItemId: (item) => item.id,
  toListItem: (entity) => ({ id: entity.id, label: entity.label }),
  list: {
    key: (event) => ['workspace', packedWorkspace(event), 'entities'],
    shape: 'array',
    createAt: 'start',
    updateMissing: 'skip',
    compare: (left, right) => left.label.localeCompare(right.label),
  },
  detailKey: (event) => ['entities', event.id],
});
packedCache.created(
  { id: 'e1', workspaceId: 'w1', label: 'one', internal: 'private' },
  { queryClient: packedQueryClient, isFresh: () => false },
);
check(
  'the packed projected/scoped entity cache compiles without assertions',
  packedQueryClient.getQueryData<PackedListItem[]>(['workspace', 'w1', 'entities'])?.[0]
    ?.label === 'one',
);

const defaultMcpHandler = createMcpHandler({
  serverInfo: { name: 'consumer', version: '1' },
  auth: () => ({ id: 'consumer' }),
  services: [],
  runtimeTools: [nativeDefinition],
  resources: [
    {
      uri: packedResourceUri,
      name: 'Packed native update',
      ui: { prefersBorder: true },
      read: () => '<!doctype html><main>Packed MCP App</main>',
    },
  ],
});
check(
  'the packed handler accepts the default stateless config',
  typeof defaultMcpHandler.fetch === 'function' &&
    typeof defaultMcpHandler.close === 'function',
);
const packedRoute = createMcpHttpRoute({ path: '/mcp', handler: defaultMcpHandler });
check(
  'the packed framework-owned MCP route owns method/path/wrapper wiring',
  packedRoute.method === 'ALL' && packedRoute.path === '/mcp',
);

const httpTransport = new StreamableHTTPClientTransport(new URL('http://consumer.test/mcp'), {
  fetch: (input, init) => defaultMcpHandler.fetch(new Request(input, init)),
});
const httpClient = new Client(
  { name: 'packed-bun-http', version: '1' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
);
await httpClient.connect(httpTransport);
check(
  'the packed Bun consumer completes a modern HTTP tool call',
  JSON.stringify(
    (
      await httpClient.callTool({
        name: 'native_update',
        arguments: { id: 'packed-http' },
      })
    ).structuredContent,
  ) === JSON.stringify({ updated: true }),
);
const packedResources = await httpClient.listResources();
check(
  'the packed MCP App resource is discoverable with the apps MIME type',
  packedResources.resources.some(
    (resource) =>
      resource.uri === packedResourceUri && resource.mimeType === RESOURCE_MIME_TYPE,
  ),
  packedResources.resources,
);
const packedResource = await httpClient.readResource({ uri: packedResourceUri });
check(
  'the packed MCP App resource preserves HTML and UI metadata',
  JSON.stringify(packedResource).includes('Packed MCP App') &&
    JSON.stringify(packedResource).includes('prefersBorder'),
  packedResource,
);
await httpClient.close();
await defaultMcpHandler.close();

const stdioTransport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL('./mcp-stdio-server.ts', import.meta.url).pathname],
  stderr: 'pipe',
});
const stdioClient = new Client(
  { name: 'packed-bun-stdio', version: '1' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
);
await stdioClient.connect(stdioTransport);
const stdioResult = await stdioClient.callTool({
  name: 'echo_packed',
  arguments: { text: 'packed Bun stdio' },
});
check(
  'the packed Bun consumer completes a modern stdio tool call',
  JSON.stringify(stdioResult.structuredContent) ===
    JSON.stringify({ text: 'packed Bun stdio' }),
  stdioResult.structuredContent,
);
await stdioClient.close();
if (process.env.STITCHKIT_COMPILE_REMOVED_API) {
  createMcpHandler({
    serverInfo: { name: 'consumer', version: '1' },
    auth: () => ({ id: 'consumer' }),
    services: [],
    // @ts-expect-error MCP v2 HTTP is stateless-only; session modes were removed.
    sessionMode: 'stateful',
  });
}

validateMcpSchemas({ services: [service], requirePortableFormats: true });
if (process.env.STITCHKIT_COMPILE_REMOVED_API) {
  // @ts-expect-error 0.37 accepts one object; positional validation is gone.
  validateMcpSchemas([service], 'throw');
}

// ── types a consumer is required to name ─────────────────────────────────────

const lifecycle: ToolLifecycle = { beforeHandle: () => undefined };
const errorHint: ErrorHintFn = () => null;

const seenByOnToolError: unknown[] = [];
const seenByAfterToolCall: Array<{
  result: ToolResult;
  error: unknown;
  context: ToolCallContext;
}> = [];
const events: RequestEvent[] = [];

const audit = createObservability({
  tools: { write: (e: RequestEvent) => void events.push(e) },
});

const hooks: ToolCallHooks = {
  onToolError: ({ error }) => {
    seenByOnToolError.push(error);
  },
  afterToolCall: ({ toolName, args, result, durationMs, context, endpoint, error }) => {
    seenByAfterToolCall.push({ result, error, context });
    // Chain the framework's own audit hook, exactly as a project would.
    void audit.toolCall.afterToolCall?.({
      toolName,
      args,
      result,
      durationMs,
      context,
      endpoint,
      error,
    });
  },
};

// ── through a real mount ─────────────────────────────────────────────────────

const tools = mountAgent(service, { hooks, lifecycle, errorHint });
const execute = tools.update_widget?.execute;
if (!execute) {
  console.error('  ✗ the mount produced no update_widget tool');
  process.exit(1);
}

// The framework logs an unexpected throw on stderr by design; keep the fixture's
// own output readable.
const originalError = console.error;
const suppressed: unknown[] = [];
console.error = (...args: unknown[]) => void suppressed.push(args[0]);
const failure: unknown = await execute(
  { id: 'boom', name: 'x' },
  { toolCallId: 't1', messages: [], context: undefined },
);
const success: unknown = await execute(
  { id: 'w1', name: 'x' },
  { toolCallId: 't2', messages: [], context: undefined },
);
console.error = originalError;

check(
  'the framework still reports the raw cause on stderr',
  suppressed.length === 1,
  suppressed,
);
check('a failing tool returns an envelope, not a throw', failure !== undefined);
check('a working tool still returns', success !== undefined);

check('onToolError fired once', seenByOnToolError.length === 1, seenByOnToolError.length);
check('it received the value as thrown', seenByOnToolError[0] === thrown);

check('afterToolCall ran for both calls', seenByAfterToolCall.length === 2);
check('the failed call carried the raw value', seenByAfterToolCall[0]?.error === thrown);
check('the successful call carried none', seenByAfterToolCall[1]?.error === undefined);
check(
  'the caller still gets the scrubbed envelope',
  JSON.stringify(seenByAfterToolCall[0]?.result).includes('INTERNAL_SERVER_ERROR'),
  seenByAfterToolCall[0]?.result,
);

// The audit hook is asynchronous by design — let its detached write land.
await new Promise((resolve) => setTimeout(resolve, 20));

const failedRow = events.find((e) => e.ok === false);
check('the audit row exists', failedRow !== undefined);
check(
  'and it names the cause instead of the placeholder',
  failedRow?.errorMessage === 'ECONNREFUSED 10.0.0.4:5432',
  failedRow?.errorMessage,
);
check(
  'while the code stays the contract-stable one',
  failedRow?.errorCode === 'INTERNAL_SERVER_ERROR',
);
check(
  'identity is on the row',
  failedRow?.serviceName === 'widgets' && failedRow?.action === 'update',
  {
    serviceName: failedRow?.serviceName,
    action: failedRow?.action,
  },
);

const inlinedApp = inlineMcpAppBundle(
  `<script type="module">${EXT_APPS_BUNDLE_PLACEHOLDER}</script>`,
);
check(
  'the packed MCP Apps peer inlines its browser runtime',
  !inlinedApp.includes(EXT_APPS_BUNDLE_PLACEHOLDER) &&
    inlinedApp.includes('globalThis.ExtApps'),
  inlinedApp.slice(-200),
);

if (failures > 0) {
  console.error(`full consumer: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('full consumer: ok');
