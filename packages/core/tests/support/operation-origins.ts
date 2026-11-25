/**
 * Shared test factory for operation origins (`native`, `contract`, `discovered-openapi`,
 * `discovered-mcp`, `managed-cli-catalog`) plus the shared `startMcp` JSON-RPC test server.
 */
import { z } from 'zod';
import {
  defineContract,
  type EndpointDef,
  type EndpointToolAnnotations,
  type RuntimeContext,
  type ToolTransport,
} from '../../src/entrypoints/contract';
import {
  defineMcpClientConnection,
  defineOpenApiConnection,
  type McpConnectionCatalogEntry,
  mountConnections,
} from '../../src/entrypoints/tools/connections';
import { isRecord } from '../../src/internal/typed';
import { createImplement } from '../../src/server/implement';
import type { ServiceDef } from '../../src/server/types';
import { createMcpHandler } from '../../src/tools/mcp/handler';
import { defineRuntimeTool, type RuntimeToolDefinition } from '../../src/tools/runtime-tool';
import { buildToolPresentationSchema } from '../../src/tools/schema/presentation';

export type OperationOrigin =
  | 'native'
  | 'contract'
  | 'discovered-openapi'
  | 'discovered-mcp'
  | 'managed-cli-catalog';
export const ALL_OPERATION_ORIGINS: readonly OperationOrigin[] = [
  'native',
  'contract',
  'discovered-openapi',
  'discovered-mcp',
  'managed-cli-catalog',
];
export type OperationMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface OperationOriginSpec {
  readonly name: string;
  readonly description: string;
  readonly method?: OperationMethod;
  readonly input: z.ZodObject<z.ZodRawShape>;
  readonly output?: z.ZodType;
  readonly annotations?: EndpointToolAnnotations;
  readonly handler: (input: Record<string, unknown>) => unknown | Promise<unknown>;
}

export interface MountedOperationOrigin {
  readonly origin: OperationOrigin;
  readonly services: readonly ServiceDef[];
  readonly runtimeTools: readonly RuntimeToolDefinition[];
  readonly catalogCacheHit?: boolean;
  commandName(specName: string): string;
}

export interface FakeMcpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly annotations?: Record<string, unknown>;
}

export type McpCallEnvelope = (args: unknown, name?: string) => unknown | Promise<unknown>;

const implement = createImplement<RuntimeContext>();
const ALL_SURFACES: readonly ToolTransport[] = ['CLI', 'MCP', 'AGENT'];
const defaultEnvelope: McpCallEnvelope = (args) => ({
  content: [{ type: 'text', text: JSON.stringify({ echoed: args }) }],
  structuredContent: { echoed: args },
});

/** Start an HTTP JSON-RPC MCP test server (supports optional `outputSchema` and `annotations`). */
export function startMcp(
  tools: readonly (FakeMcpTool | Record<string, unknown>)[],
  envelope: McpCallEnvelope = defaultEnvelope,
): { url: string; stop: () => Promise<void> } {
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      if (req.method === 'GET') return new Response('', { status: 404 });
      const raw: unknown = await req.json();
      if (!isRecord(raw) || typeof raw.method !== 'string')
        return new Response('', { status: 400 });
      if (typeof raw.id !== 'number') return new Response(null, { status: 202 });
      const p = isRecord(raw.params) ? raw.params : undefined;
      const result =
        raw.method === 'initialize'
          ? {
              protocolVersion: '2024-11-05',
              capabilities: {},
              serverInfo: { name: 'fake', version: '1' },
            }
          : raw.method === 'tools/list'
            ? { tools }
            : await envelope(p?.arguments, typeof p?.name === 'string' ? p.name : undefined);
      return Response.json({ jsonrpc: '2.0', id: raw.id, result });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/mcp`, stop: () => server.stop(true) };
}

function buildService(name: string, specs: readonly OperationOriginSpec[]) {
  const endpoints: Record<string, EndpointDef> = {};
  const handlers: Record<string, (ctx: { input?: unknown }) => unknown> = {};
  for (const s of specs) {
    endpoints[s.name] = {
      method: s.method ?? 'GET',
      path: `/${s.name}`,
      desc: s.description,
      expose: ['HTTP', 'CLI', 'MCP', 'AGENT'],
      input: s.input,
      ...(s.output && { output: s.output }),
      tool: { name: s.name, ...(s.annotations && { annotations: s.annotations }) },
    };
    handlers[s.name] = (ctx) => s.handler(isRecord(ctx.input) ? ctx.input : {});
  }
  return implement(defineContract({ prefix: name, scope: 'public' }, endpoints), handlers);
}

function buildOpenApiDoc(specs: readonly OperationOriginSpec[]) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const s of specs) {
    const m = (s.method ?? 'GET').toLowerCase();
    const inJson = buildToolPresentationSchema({ inputSchema: s.input });
    const props = isRecord(inJson.properties) ? inJson.properties : {};
    const req = new Set(Array.isArray(inJson.required) ? inJson.required.map(String) : []);
    const out = s.output ? buildToolPresentationSchema({ inputSchema: s.output }) : undefined;
    const ok = out
      ? { description: 'ok', content: { 'application/json': { schema: out } } }
      : { description: 'ok' };
    const op: Record<string, unknown> = {
      operationId: s.name,
      description: s.description,
      responses: { '200': ok },
    };
    if (m === 'get' || m === 'delete') {
      op.parameters = Object.entries(props).map(([name, schema]) => ({
        name,
        in: 'query',
        required: req.has(name),
        ...(isRecord(schema) &&
          typeof schema.description === 'string' && {
            description: schema.description,
          }),
        schema,
      }));
    } else {
      op.requestBody = { required: true, content: { 'application/json': { schema: inJson } } };
    }
    paths[`/${s.name}`] = { [m]: op };
  }
  return { openapi: '3.1.0', info: { title: 'origin-factory', version: '1.0.0' }, paths };
}

function startLiveMcp(
  name: string,
  specs: readonly OperationOriginSpec[],
  stops: Array<() => Promise<void>>,
) {
  const handler = createMcpHandler({
    access: { open: 'local-operator' },
    serverInfo: { name, version: '1' },
    auth: () => ({}),
    context: () => ({}),
    services: [buildService(name, specs)],
  });
  let lists = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      if (req.method === 'POST') {
        const cloned = req.clone();
        const body: unknown = await cloned.json().catch(() => null);
        if (isRecord(body) && body.method === 'tools/list') lists += 1;
      }
      return handler.fetch(req);
    },
  });
  stops.push(async () => {
    await server.stop(true);
    await handler.close();
  });
  return { url: `http://127.0.0.1:${server.port}/mcp`, lists: () => lists };
}

async function mountOpenApi(
  name: string,
  specs: readonly OperationOriginSpec[],
  stops: Array<() => Promise<void>>,
): Promise<MountedOperationOrigin> {
  const byPath = new Map(specs.map((s) => [`/${s.name}`, s]));
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const spec = byPath.get(url.pathname);
      if (!spec) return new Response('not found', { status: 404 });
      const raw: unknown =
        req.method === 'GET' || req.method === 'DELETE'
          ? Object.fromEntries(url.searchParams)
          : await req.json().catch(() => ({}));
      return Response.json((await spec.handler(isRecord(raw) ? raw : {})) ?? null);
    },
  });
  stops.push(() => server.stop(true));
  const spec = buildOpenApiDoc(specs);
  const conn = defineOpenApiConnection({
    name,
    spec,
    baseUrl: `http://127.0.0.1:${server.port}`,
    expose: ALL_SURFACES,
  });
  const runtimeTools = await mountConnections([conn]);
  return {
    origin: 'discovered-openapi',
    services: [],
    runtimeTools,
    commandName: (n) => `${name}__${n}`,
  };
}

/** Mount operation specs across origins, sharing one HTTP MCP server. Call `close()` in `afterAll`. */
export async function mountOperationOrigins(options: {
  readonly serviceName?: string;
  readonly specs: readonly OperationOriginSpec[];
  readonly origins?: readonly OperationOrigin[];
}) {
  const name = options.serviceName ?? 'ops';
  const origins = options.origins ?? ALL_OPERATION_ORIGINS;
  const stops: Array<() => Promise<void>> = [];
  const byOrigin = new Map<OperationOrigin, MountedOperationOrigin>();
  let shared: { url: string; lists: () => number } | undefined;
  const mcp = () => (shared ??= startLiveMcp(name, options.specs, stops));
  const id = (n: string) => n;
  const close = async () => {
    await Promise.allSettled(stops.splice(0).map((s) => s()));
  };
  try {
    for (const origin of origins) {
      if (origin === 'native') {
        const runtimeTools = options.specs.map((s) =>
          defineRuntimeTool({
            name: s.name,
            description: s.description,
            identity: { serviceName: name, action: s.name, method: s.method ?? 'GET' },
            expose: ALL_SURFACES,
            input: s.input,
            output: s.output ?? z.unknown(),
            ...(s.annotations && { annotations: s.annotations }),
            handler: ({ input }) => s.handler(isRecord(input) ? input : {}),
          }),
        );
        byOrigin.set(origin, { origin, services: [], runtimeTools, commandName: id });
      } else if (origin === 'contract') {
        const services = [buildService(name, options.specs)];
        byOrigin.set(origin, { origin, services, runtimeTools: [], commandName: id });
      } else if (origin === 'discovered-openapi') {
        byOrigin.set(origin, await mountOpenApi(name, options.specs, stops));
      } else {
        const srv = mcp();
        let stored: McpConnectionCatalogEntry | undefined;
        const catalog =
          origin === 'managed-cli-catalog'
            ? {
                load: () => stored,
                store: (e: McpConnectionCatalogEntry) => {
                  stored = e;
                },
              }
            : undefined;
        const conn = defineMcpClientConnection({
          name,
          transport: { url: srv.url },
          ...(catalog && { catalog }),
          expose: ALL_SURFACES,
        });
        if (catalog) await mountConnections([conn]);
        const before = srv.lists();
        const runtimeTools = await mountConnections([conn]);
        byOrigin.set(origin, {
          origin,
          services: [],
          runtimeTools,
          ...(catalog && {
            catalogCacheHit: stored !== undefined && before > 0 && srv.lists() === before,
          }),
          commandName: id,
        });
      }
    }
  } catch (error) {
    await close();
    throw error;
  }
  return { byOrigin, close };
}
