import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createCli, createCliInvoker, defineCliCommand } from '../src/entrypoints/cli';
import { createManagedFileBoundary } from '../src/entrypoints/files';
import {
  createRuntimeToolFactory,
  defineAsyncOperation,
  defineDownloadTool,
  defineRuntimeTool,
  defineToolRegistry,
  defineUploadTool,
  defineViewFileTool,
  defineWaitTool,
  listToolNames,
} from '../src/entrypoints/tools';
import { mountAgent } from '../src/entrypoints/tools/agent';
import {
  defineMcpClientConnection,
  defineOpenApiConnection,
  mountConnections,
} from '../src/entrypoints/tools/connections';
import { buildMcpServer } from '../src/entrypoints/tools/mcp';
import { startMcp } from './support/operation-origins';
import { connectRecording, runCliSurface } from './support/operation-transports';

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
});

function expectLegacyTransportsTypeError(fn: () => unknown): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TypeError);
  if (caught instanceof Error) {
    expect(caught.message).toMatch(/"transports" was renamed to "expose"/);
  }
}

async function expectLegacyTransportsTypeErrorAsync(
  fn: () => Promise<unknown>,
): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TypeError);
  if (caught instanceof Error) {
    expect(caught.message).toMatch(/"transports" was renamed to "expose"/);
  }
}

describe('expose replaces transports in tool and connection declarations', () => {
  test('legacy transports key via spread throws TypeError on every tool and connection factory', async () => {
    const legacy: Record<string, unknown> = { transports: ['AGENT'] };
    const files = await createManagedFileBoundary({ root: '/tmp' });
    const idSchema = z.object({ id: z.string() });
    const snapSchema = z.object({ phase: z.literal('succeeded') });

    expectLegacyTransportsTypeError(() =>
      defineRuntimeTool({
        name: 'legacy_runtime',
        description: 'Legacy runtime tool',
        identity: { serviceName: 'demo', action: 'legacy', method: 'GET' },
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        handler: () => ({ ok: true }),
        ...legacy,
      }),
    );

    const factory = createRuntimeToolFactory({
      serviceName: 'demo',
      context: z.object({}),
    });
    expectLegacyTransportsTypeError(() =>
      factory.define({
        name: 'legacy_factory',
        description: 'Legacy factory tool',
        action: 'legacy',
        method: 'GET',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        handler: () => ({ ok: true }),
        ...legacy,
      }),
    );

    expectLegacyTransportsTypeError(() =>
      defineDownloadTool({
        description: 'Download file',
        identity: { serviceName: 'demo', action: 'download' },
        input: z.object({ id: z.string() }),
        resolveUrl: () => 'https://example.com/a.txt',
        files,
        ...legacy,
      }),
    );

    expectLegacyTransportsTypeError(() =>
      defineUploadTool({
        description: 'Upload file',
        identity: { serviceName: 'demo', action: 'upload' },
        output: z.object({ ok: z.boolean() }),
        files,
        upload: () => ({ ok: true }),
        ...legacy,
      }),
    );

    expectLegacyTransportsTypeError(() =>
      defineViewFileTool({
        description: 'View file',
        identity: { serviceName: 'demo', action: 'view' },
        files,
        ...legacy,
      }),
    );

    expectLegacyTransportsTypeError(() =>
      defineWaitTool({
        description: 'Wait op',
        identity: { serviceName: 'demo', action: 'wait' },
        input: idSchema,
        state: snapSchema,
        poll: () => ({ phase: 'succeeded' as const }),
        done: () => true,
        ...legacy,
      }),
    );

    const legacyAsync: Record<string, unknown> = { transports: { wait: ['CLI'] } };
    expectLegacyTransportsTypeError(() =>
      defineAsyncOperation({
        mode: 'runtime-only',
        name: 'job',
        description: 'Async job',
        identity: { serviceName: 'demo', action: 'job' },
        startInput: z.object({}),
        id: idSchema,
        state: snapSchema,
        snapshot: snapSchema,
        start: () => ({ id: '1' }),
        authorize: () => undefined,
        inspect: () => ({ phase: 'succeeded' as const }),
        classify: (state) => state,
        ...legacyAsync,
      }),
    );

    expectLegacyTransportsTypeError(() =>
      defineMcpClientConnection({
        name: 'remote',
        transport: { url: 'https://example.com/mcp' },
        ...legacy,
      }),
    );

    expectLegacyTransportsTypeError(() =>
      defineOpenApiConnection({
        name: 'remote_api',
        spec: { openapi: '3.1.0', info: { title: 't', version: '1' }, paths: {} },
        baseUrl: 'https://example.com',
        ...legacy,
      }),
    );
  });

  test('own transports key with value undefined still throws TypeError (Object.hasOwn)', () => {
    const legacyUndefined: Record<string, unknown> = { transports: undefined };
    expectLegacyTransportsTypeError(() =>
      defineRuntimeTool({
        name: 'legacy_undefined',
        description: 'Legacy undefined transports key',
        identity: { serviceName: 'demo', action: 'legacyUndefined', method: 'GET' },
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        handler: () => ({ ok: true }),
        ...legacyUndefined,
      }),
    );
    expectLegacyTransportsTypeError(() =>
      defineMcpClientConnection({
        name: 'remote_undef',
        transport: { url: 'https://example.com/mcp' },
        ...legacyUndefined,
      }),
    );
  });

  test('tool with expose: ["AGENT"] is absent from MCP tools/list and visible in AGENT', async () => {
    const agentOnly = defineRuntimeTool({
      name: 'agent_only_tool',
      description: 'Agent only',
      identity: { serviceName: 'demo', action: 'agentOnly', method: 'GET' },
      expose: ['AGENT'],
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    });
    const mcpAndAgent = defineRuntimeTool({
      name: 'shared_tool',
      description: 'Default MCP and AGENT',
      identity: { serviceName: 'demo', action: 'shared', method: 'GET' },
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    });

    const agentTools = mountAgent([], {
      access: { open: 'local-operator' },
      runtimeTools: [agentOnly, mcpAndAgent],
    });
    expect(Object.keys(agentTools).sort()).toEqual(['agent_only_tool', 'shared_tool']);

    const server = buildMcpServer(
      {
        access: { open: 'local-operator' },
        serverInfo: { name: 'expose-check', version: '1.0.0' },
        services: [],
        runtimeTools: [agentOnly, mcpAndAgent],
      },
      undefined,
    );
    const { client } = await connectRecording(server);
    stops.push(async () => {
      await client.close();
      await server.close();
    });
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(['shared_tool']);
  });

  test('listToolNames returns expose (not transports)', () => {
    const cliOnly = defineRuntimeTool({
      name: 'cli_only_tool',
      description: 'CLI only',
      identity: { serviceName: 'demo', action: 'cliOnly', method: 'GET' },
      expose: ['CLI'],
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    });
    const entries = listToolNames({ runtimeTools: [cliOnly] });
    expect(entries).toEqual([
      {
        kind: 'runtime',
        name: 'cli_only_tool',
        service: 'demo',
        method: 'cliOnly',
        expose: ['CLI'],
      },
    ]);
    expect('transports' in (entries[0] ?? {})).toBe(false);
  });

  test('McpClientConnectionConfig.expose controls which surfaces mount discovered tools', async () => {
    const server = startMcp([
      {
        name: 'ping',
        description: 'Ping remote',
        inputSchema: { type: 'object', properties: {} },
      },
    ]);
    stops.push(server.stop);

    const cliTools = await mountConnections([
      defineMcpClientConnection({
        name: 'remote',
        transport: { url: server.url },
        expose: ['CLI'],
      }),
    ]);

    expect(
      Object.keys(
        mountAgent([], { access: { open: 'local-operator' }, runtimeTools: cliTools }),
      ),
    ).toEqual([]);
    const cli = await runCliSurface({ runtimeTools: cliTools }, ['--help']);
    expect(cli.code).toBe(0);
    expect(cli.out).toContain('ping');
  });

  test('raw runtime tool and raw connection objects with legacy transports throw TypeError across mount entrypoints', async () => {
    const legacy: Record<string, unknown> = { transports: ['AGENT'] };
    const raw = {
      name: 'raw_legacy',
      description: 'Raw runtime tool without defineRuntimeTool',
      identity: { serviceName: 'demo', action: 'rawLegacy', method: 'GET' as const },
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
      ...legacy,
    };
    const validTool = defineRuntimeTool({
      name: 'raw_legacy',
      description: 'Valid runtime tool',
      identity: { serviceName: 'demo', action: 'rawLegacy', method: 'GET' },
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    });
    const nativeCmd = defineCliCommand({
      name: 'ping',
      description: 'Native CLI command',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    });

    expectLegacyTransportsTypeError(() => listToolNames({ runtimeTools: [raw] }));
    expectLegacyTransportsTypeError(() =>
      mountAgent([], { access: { open: 'local-operator' }, runtimeTools: [raw] }),
    );
    expectLegacyTransportsTypeError(() =>
      buildMcpServer(
        {
          access: { open: 'local-operator' },
          serverInfo: { name: 'raw-check', version: '1.0.0' },
          services: [],
          runtimeTools: [raw],
        },
        undefined,
      ),
    );
    expectLegacyTransportsTypeError(() => defineToolRegistry({ defaults: [raw] }));
    expectLegacyTransportsTypeError(() =>
      defineToolRegistry({ defaults: [validTool] }).replace('raw_legacy', raw),
    );

    const cliOpts = {
      name: 'raw-cli',
      version: '1.0.0',
      runtimeTools: [raw],
      access: { open: 'local-operator' } as const,
      commands: [nativeCmd],
      stdout: () => undefined,
      stderr: () => undefined,
      exit: () => undefined,
      stdin: async () => null,
    };
    await expectLegacyTransportsTypeErrorAsync(() =>
      createCli({ ...cliOpts, argv: ['--version'] }),
    );
    await expectLegacyTransportsTypeErrorAsync(() =>
      createCli({ ...cliOpts, argv: ['ping'] }),
    );
    await expectLegacyTransportsTypeErrorAsync(() =>
      createCliInvoker({
        access: { open: 'local-operator' },
        name: 'raw-cli',
        runtimeTools: [raw],
      }),
    );

    const rawMcpConn = {
      kind: 'mcp' as const,
      name: 'raw_mcp',
      transport: { url: 'https://example.com/mcp' },
      ...legacy,
    };
    const rawOpenApiConn = {
      kind: 'openapi' as const,
      name: 'raw_openapi',
      spec: { openapi: '3.1.0', info: { title: 't', version: '1' }, paths: {} },
      baseUrl: 'https://example.com',
      ...legacy,
    };
    await expectLegacyTransportsTypeErrorAsync(() => mountConnections([rawMcpConn]));
    await expectLegacyTransportsTypeErrorAsync(() => mountConnections([rawOpenApiConn]));
  });
});
