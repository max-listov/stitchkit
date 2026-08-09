/**
 * A consumer that opted into the optional peers and mounts the tool surface.
 *
 * This is where the observability work of 0.30–0.32 has to be proved from the
 * outside: the hook that carries the cause of a failed tool call, and the audit
 * row that names it. Both were reported by a consuming project rather than
 * caught here, because in-repo tests call the executor directly — they never go
 * through a real mount, from an installed package, with the peer present.
 */

import { QueryClient } from '@tanstack/react-query';
import { ApiError } from 'stitchkit';
import { defineContract, defineErrors } from 'stitchkit/contract';
import { createObservability, type RequestEvent } from 'stitchkit/observability';
import { createEntityCacheHandlers, type EntityCacheEvent } from 'stitchkit/react';
import { implement } from 'stitchkit/server';
import {
  buildMcpServer,
  buildToolManifest,
  createMcpHandler,
  defineRuntimeTool,
  type ErrorHintFn,
  EXT_APPS_BUNDLE_PLACEHOLDER,
  flattenToolJsonSchema,
  inlineMcpAppBundle,
  listToolNames,
  mountAgent,
  summarizeTransports,
  type ToolCallContext,
  type ToolCallHooks,
  type ToolLifecycle,
  type ToolPresentationSchema,
  type ToolResult,
  validateMcpSchemas,
} from 'stitchkit/tools';
import { z } from 'zod';

declare const process: { env: Record<string, string | undefined>; exit(code: number): never };

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
      expose: ['AGENT'],
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

const NativeInputSchema = z.object({ id: z.string() });
const NativeOutputSchema = z.object({ updated: z.boolean() });
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
check(
  'the packed Agent mount accepts the same runtime definition',
  typeof mountAgent([], { runtimeTools: [nativeDefinition] }).native_update?.execute ===
    'function',
);
const packedSurface = { services: [service], runtimeTools: [nativeDefinition] };
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
});
check(
  'the packed handler accepts the default stateless config',
  typeof defaultMcpHandler === 'function',
);
if (process.env.STITCHKIT_COMPILE_REMOVED_API) {
  createMcpHandler({
    serverInfo: { name: 'consumer', version: '1' },
    auth: () => ({ id: 'consumer' }),
    services: [],
    // @ts-expect-error 0.37 removed the boolean; sessionMode is the only shape.
    stateless: true,
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

// This fixture installs the tool peers but deliberately omits ext-apps. The
// tools entrypoint remains usable; only requesting its browser bundle fails.
let missingExtAppsMessage = '';
try {
  inlineMcpAppBundle(`<script>${EXT_APPS_BUNDLE_PLACEHOLDER}</script>`);
} catch (error) {
  missingExtAppsMessage = error instanceof Error ? error.message : String(error);
}
check(
  'missing ext-apps fails only when bundle inlining is requested',
  missingExtAppsMessage.includes('@modelcontextprotocol/ext-apps'),
  missingExtAppsMessage,
);

if (failures > 0) {
  console.error(`full consumer: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('full consumer: ok');
