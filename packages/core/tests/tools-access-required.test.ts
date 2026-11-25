import { describe, expect, test } from 'bun:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  type AgentRuntimeRunContext,
  createDeferredAgentToolSurface,
} from '../src/entrypoints/agent-runtime';
import { createCli, createCliInvoker, defineCliCommand } from '../src/entrypoints/cli';
import { defineContract, forbidden } from '../src/entrypoints/contract';
import { implement } from '../src/entrypoints/server';
import {
  composeToolLifecycle,
  createToolInvoker,
  defineRuntimeTool,
} from '../src/entrypoints/tools';
import { mountAgent } from '../src/entrypoints/tools/agent';
import {
  buildMcpServer,
  createMcpHandler,
  createStdioMcpServer,
  mountMcp,
} from '../src/entrypoints/tools/mcp';
import { createToolkit } from '../src/entrypoints/tools/toolkit';
import { buildCliSurface } from '../src/tools/cli/invoke';
import { createCliIo } from '../src/tools/cli/io';
import { createCliSession } from '../src/tools/cli/session';
import { buildMcpServerFromPrepared, mountPreparedMcp } from '../src/tools/mcp/mount';
import { prepareMcpServerSurface, prepareMcpSurface } from '../src/tools/mcp/prepare';
import { issuedRunContext } from './support/issued-run-context';

const itemContract = defineContract(
  { prefix: '/items' },
  {
    get: {
      method: 'GET',
      path: '/get',
      desc: 'Get an item',
      expose: ['MCP', 'AGENT', 'CLI'],
      tool: { name: 'get_item' },
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string(), tag: z.string().optional() }),
    },
  },
);

const itemService = implement(itemContract, {
  get: async ({ input }) => ({ id: input.id }),
});

const pingRuntimeTool = defineRuntimeTool({
  name: 'ping_tool',
  description: 'Ping runtime tool',
  identity: { serviceName: 'ping', action: 'run', method: 'GET' },
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  expose: ['MCP', 'AGENT', 'CLI'],
  handler: async () => ({ ok: true }),
});

const nativePing = defineCliCommand({
  name: 'native_ping',
  description: 'Native ping',
  input: z.object({}),
  output: z.object({ pong: z.boolean() }),
  handler: () => ({ pong: true }),
});

const serverInfo = { name: 'access-test', version: '1.0.0' };
const preparedSurface = prepareMcpSurface(itemService);
const deferredSurface = createDeferredAgentToolSurface({
  services: [itemService],
  search: { name: 'find_tools', maxQueryBytes: 1024, maxResults: 5, maxResultBytes: 4096 },
  activation: { maxSelectedTools: 5, maxActiveTools: 10, maxSchemaBytes: 32_768 },
});

function makeRunContext(): AgentRuntimeRunContext<unknown> {
  return issuedRunContext('conv-1');
}

function callUntyped(fn: (...args: never[]) => unknown, ...args: unknown[]): unknown {
  return Reflect.apply(fn, undefined, args);
}

describe('tool access compile-time checks', () => {
  test('type-level checks compile only when every negative case is rejected', () => {
    const typeChecks = () => {
      const server = new McpServer(serverInfo);
      const toolkit = createToolkit<{ userId: string }>();
      const runCtx = makeRunContext();

      // Missing config / missing access on every mount entrypoint
      // @ts-expect-error — mountAgent requires config with access
      mountAgent(itemService);
      // @ts-expect-error — mountAgent requires access
      mountAgent(itemService, {});
      // @ts-expect-error — mountMcp requires config with access
      mountMcp(server, itemService);
      // @ts-expect-error — mountMcp requires access
      mountMcp(server, itemService, {});
      // @ts-expect-error — mountPreparedMcp requires config with access
      mountPreparedMcp(server, preparedSurface);
      // @ts-expect-error — mountPreparedMcp requires access
      mountPreparedMcp(server, preparedSurface, {});
      // @ts-expect-error — buildMcpServer requires access
      buildMcpServer({ serverInfo, services: [itemService] });
      buildMcpServerFromPrepared(
        // @ts-expect-error — buildMcpServerFromPrepared requires access
        { serverInfo, services: [itemService] },
        undefined,
        prepareMcpServerSurface({ services: [itemService] }),
      );
      // @ts-expect-error — createMcpHandler requires access
      createMcpHandler({ serverInfo, services: [itemService], auth: () => ({}) });
      // @ts-expect-error — createStdioMcpServer requires access
      void createStdioMcpServer({ serverInfo, services: [itemService], auth: {} });
      // @ts-expect-error — createToolInvoker requires access
      createToolInvoker(itemService, { transport: 'MCP' });
      const validInvoker = createToolInvoker(itemService, {
        transport: 'MCP',
        access: { open: 'local-operator' },
      });
      // @ts-expect-error — per-call lifecycle was removed from ToolInvocationOptions
      void validInvoker.invoke('get_item', { id: '1' }, { lifecycle: {} });
      // @ts-expect-error — toolkit.mountMcp requires config with access
      toolkit.mountMcp(server, itemService);
      // @ts-expect-error — toolkit.mountMcp requires access
      toolkit.mountMcp(server, itemService, {});
      // @ts-expect-error — toolkit.mountAgent requires config with access
      toolkit.mountAgent(itemService);
      // @ts-expect-error — toolkit.mountAgent requires access
      toolkit.mountAgent(itemService, {});
      // @ts-expect-error — toolkit.buildMcpServer requires access
      toolkit.buildMcpServer({ serverInfo, services: [itemService] });
      // @ts-expect-error — toolkit.createMcpHandler requires access
      toolkit.createMcpHandler({ serverInfo, services: [itemService], auth: () => ({}) });
      // @ts-expect-error — toolkit.createStdioMcpServer requires access
      void toolkit.createStdioMcpServer({ serverInfo, services: [itemService], auth: {} });
      // @ts-expect-error — toolkit.createCli with services requires access
      void toolkit.createCli({ name: 'tk', version: '1.0.0', services: [itemService] });
      // @ts-expect-error — deferred.mount requires config with access
      deferredSurface.mount(runCtx);
      // @ts-expect-error — deferred.mount requires access
      deferredSurface.mount(runCtx, {});
      // @ts-expect-error — createCli with services requires access
      void createCli({ name: 'cli', version: '1.0.0', services: [itemService] });
      // @ts-expect-error — createCli with empty services array requires access
      void createCli({ name: 'cli', version: '1.0.0', services: [] });
      // @ts-expect-error — createCli with services factory requires access
      void createCli({ name: 'cli', version: '1.0.0', services: () => [itemService] });
      // @ts-expect-error — createCli with runtimeTools requires access
      void createCli({ name: 'cli', version: '1.0.0', runtimeTools: [pingRuntimeTool] });
      // @ts-expect-error — createCliInvoker with services requires access
      void createCliInvoker({ name: 'cli', services: [itemService] });
      // @ts-expect-error — createCliInvoker with runtimeTools requires access
      void createCliInvoker({ name: 'cli', runtimeTools: [pingRuntimeTool] });

      // Invalid access shapes
      // @ts-expect-error — empty access object is forbidden
      mountAgent(itemService, { access: {} });
      // @ts-expect-error — gate requires beforeHandle
      mountAgent(itemService, { access: { gate: {} } });
      // @ts-expect-error — open only accepts closed union
      mountAgent(itemService, { access: { open: 'invalid' } });
      mountAgent(itemService, {
        // @ts-expect-error — gate and open are mutually exclusive
        access: { gate: { beforeHandle: () => undefined }, open: 'public' },
      });
      // @ts-expect-error — legacy lifecycle key is removed
      mountAgent(itemService, { lifecycle: { beforeHandle: () => undefined } });

      // composeToolLifecycle rejects undefined and missing beforeHandle on first argument
      // @ts-expect-error — composeToolLifecycle does not accept undefined
      composeToolLifecycle(undefined);
      // @ts-expect-error — composeToolLifecycle first argument must be a ToolGate
      composeToolLifecycle({});
      // @ts-expect-error — composeToolLifecycle rejects undefined in rest arguments
      composeToolLifecycle({ beforeHandle: () => undefined }, undefined);

      // Valid positive forms compile cleanly
      mountAgent(itemService, { access: { gate: { beforeHandle: () => undefined } } });
      mountAgent(itemService, { access: { open: 'public' } });
      mountAgent(itemService, {
        access: { open: 'local-operator', afterHandle: (_ctx, result) => result },
      });
      mountAgent(itemService, { access: { open: 'remote' } });
      void createCli({ name: 'native', version: '1.0.0', commands: [nativePing] });
      void createCliInvoker({ name: 'native', commands: [nativePing] });
    };
    expect(typeof typeChecks).toBe('function');
  });
});

describe('tool access runtime mount checks', () => {
  const invalidConfigs: ReadonlyArray<readonly [string, Record<string, unknown>, string?]> = [
    ['missing access', {}],
    ['empty access', { access: {} }],
    ['gate without beforeHandle', { access: { gate: {} } }],
    ['unknown open reason', { access: { open: 'invalid' } }],
    [
      'both gate and open',
      { access: { gate: { beforeHandle: () => undefined }, open: 'public' } },
    ],
    ['non-function afterHandle', { access: { open: 'public', afterHandle: 'nope' } }],
    ['legacy lifecycle', { lifecycle: { beforeHandle: () => undefined } }, 'lifecycle'],
  ];

  test('every synchronous mount entrypoint throws TypeError with its entry name before first call', () => {
    const toolkit = createToolkit<Record<string, unknown>>();
    const runCtx = makeRunContext();
    const syncEntries: ReadonlyArray<
      readonly [string, (extra: Record<string, unknown>) => unknown]
    > = [
      ['mountAgent', (extra) => callUntyped(mountAgent, itemService, extra)],
      [
        'mountMcp',
        (extra) => callUntyped(mountMcp, new McpServer(serverInfo), itemService, extra),
      ],
      [
        'mountPreparedMcp',
        (extra) =>
          callUntyped(mountPreparedMcp, new McpServer(serverInfo), preparedSurface, extra),
      ],
      [
        'buildMcpServer',
        (extra) =>
          callUntyped(buildMcpServer, { serverInfo, services: [itemService], ...extra }),
      ],
      [
        'createMcpHandler',
        (extra) =>
          callUntyped(createMcpHandler, {
            serverInfo,
            services: [itemService],
            auth: () => ({}),
            ...extra,
          }),
      ],
      [
        'createToolInvoker',
        (extra) => callUntyped(createToolInvoker, itemService, { transport: 'MCP', ...extra }),
      ],
      [
        'mountMcp',
        (extra) =>
          callUntyped(toolkit.mountMcp, new McpServer(serverInfo), itemService, extra),
      ],
      ['mountAgent', (extra) => callUntyped(toolkit.mountAgent, itemService, extra)],
      [
        'createDeferredAgentToolSurface.mount',
        (extra) => callUntyped(deferredSurface.mount, runCtx, extra),
      ],
      [
        'createCliSession',
        (extra) => {
          const cfg = { name: 'cli', version: '1.0.0', services: [itemService], ...extra };
          return callUntyped(createCliSession, cfg, createCliIo({}));
        },
      ],
      [
        'buildCliSurface',
        (extra) => {
          const cfg = { name: 'cli', services: [itemService], ...extra };
          return callUntyped(buildCliSurface, cfg, undefined, {}, new Map(), new Set());
        },
      ],
    ];

    for (const [entryName, invoke] of syncEntries) {
      for (const [_label, extra, extraSubstring] of invalidConfigs) {
        let caught: unknown;
        try {
          invoke(extra);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(TypeError);
        const message = caught instanceof Error ? caught.message : String(caught);
        expect(message).toContain(entryName);
        expect(message).toContain('access is required');
        if (extraSubstring) expect(message).toContain(extraSubstring);
      }
    }

    // Missing config argument altogether on mountAgent / mountMcp / mountPreparedMcp / deferred.mount
    expect(() => callUntyped(mountAgent, itemService)).toThrow(TypeError);
    expect(() => callUntyped(mountMcp, new McpServer(serverInfo), itemService)).toThrow(
      TypeError,
    );
    expect(() =>
      callUntyped(mountPreparedMcp, new McpServer(serverInfo), preparedSurface),
    ).toThrow(TypeError);
    expect(() => callUntyped(deferredSurface.mount, runCtx)).toThrow(TypeError);
  });

  test('async entrypoints reject immediately at startup with TypeError and entry name', async () => {
    const asyncEntries: ReadonlyArray<
      readonly [string, (extra: Record<string, unknown>) => Promise<unknown>]
    > = [
      [
        'createStdioMcpServer',
        (extra) =>
          Promise.resolve(
            callUntyped(createStdioMcpServer, {
              serverInfo,
              services: [itemService],
              auth: {},
              ...extra,
            }),
          ),
      ],
      [
        'createCli',
        (extra) =>
          Promise.resolve(
            callUntyped(createCli, {
              name: 'cli',
              version: '1.0.0',
              services: [itemService],
              argv: ['--help'],
              stdout: () => undefined,
              stderr: () => undefined,
              exit: () => undefined,
              ...extra,
            }),
          ),
      ],
      [
        'createCli',
        (extra) =>
          Promise.resolve(
            callUntyped(createCli, {
              name: 'cli',
              version: '1.0.0',
              runtimeTools: [pingRuntimeTool],
              argv: ['--help'],
              stdout: () => undefined,
              stderr: () => undefined,
              exit: () => undefined,
              ...extra,
            }),
          ),
      ],
      [
        'createCliInvoker',
        (extra) =>
          Promise.resolve(
            callUntyped(createCliInvoker, {
              name: 'cli',
              services: [itemService],
              ...extra,
            }),
          ),
      ],
      [
        'createCliInvoker',
        (extra) =>
          Promise.resolve(
            callUntyped(createCliInvoker, {
              name: 'cli',
              runtimeTools: [pingRuntimeTool],
              ...extra,
            }),
          ),
      ],
    ];

    for (const [entryName, invoke] of asyncEntries) {
      for (const [_label, extra, extraSubstring] of invalidConfigs) {
        let caught: unknown;
        try {
          await invoke(extra);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(TypeError);
        const message = caught instanceof Error ? caught.message : String(caught);
        expect(message).toContain(entryName);
        expect(message).toContain('access is required');
        if (extraSubstring) expect(message).toContain(extraSubstring);
      }
    }
  });

  test('createToolInvoker rejects legacy per-call lifecycle option at runtime', () => {
    const invoker = createToolInvoker(itemService, {
      transport: 'MCP',
      access: { open: 'local-operator' },
    });
    expect(() =>
      callUntyped(invoker.invoke, 'get_item', { id: '1' }, { lifecycle: {} }),
    ).toThrow(TypeError);
  });

  test('composeToolLifecycle rejects undefined and missing beforeHandle at runtime', () => {
    expect(() => callUntyped(composeToolLifecycle, undefined)).toThrow(TypeError);
    expect(() => callUntyped(composeToolLifecycle, {})).toThrow(TypeError);
    expect(() =>
      callUntyped(composeToolLifecycle, { beforeHandle: () => undefined }, undefined),
    ).toThrow(TypeError);
  });
});

describe('tool access runtime behaviour', () => {
  test('gate beforeHandle allows authorized calls and blocks rejected calls', async () => {
    let allow = false;
    const gate = {
      beforeHandle: () => {
        if (!allow) throw forbidden('denied by gate');
      },
    };

    const invoker = createToolInvoker(itemService, {
      transport: 'MCP',
      access: { gate },
    });
    const denied = await invoker.invoke('get_item', { id: '1' });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe('FORBIDDEN');

    allow = true;
    const allowed = await invoker.invoke('get_item', { id: '1' });
    expect(allowed).toEqual({ ok: true, data: { id: '1' } });

    allow = false;
    const agentTools = mountAgent(itemService, { access: { gate } });
    const getItem = agentTools.get_item;
    if (!getItem?.execute) throw new Error('expected get_item tool');
    const executeGetItem = getItem.execute;
    let agentError: unknown;
    try {
      await Reflect.apply(executeGetItem, undefined, [
        { id: '1' },
        { toolCallId: 'c1', messages: [] },
      ]);
    } catch (error) {
      agentError = error;
    }
    expect(agentError).toBeInstanceOf(Error);
    expect(agentError instanceof Error ? agentError.message : '').toContain('FORBIDDEN');

    const cliInvoker = await createCliInvoker({
      name: 'gated',
      services: [itemService],
      access: { gate },
    });
    const cliDenied = await cliInvoker.invoke('get_item', { id: '1' });
    expect(cliDenied.ok).toBe(false);
    expect(cliDenied.error?.code).toBe('FORBIDDEN');

    allow = true;
    const cliAllowed = await cliInvoker.invoke('get_item', { id: '1' });
    expect(cliAllowed.ok).toBe(true);
    expect(cliAllowed.data).toEqual({ id: '1' });
  });

  test('open reasons allow calls and execute afterHandle when provided', async () => {
    for (const open of ['public', 'local-operator', 'remote'] as const) {
      const invoker = createToolInvoker(itemService, {
        transport: 'MCP',
        access: {
          open,
          afterHandle: (_ctx, result) =>
            typeof result === 'object' && result !== null ? { ...result, tag: open } : result,
        },
      });
      const res = await invoker.invoke('get_item', { id: '42' });
      expect(res).toEqual({ ok: true, data: { id: '42', tag: open } });
    }
  });

  test('native-only CLI runs without access but still refuses legacy lifecycle', async () => {
    let stdout = '';
    let exitCode = -1;
    await createCli({
      name: 'native-only',
      version: '1.0.0',
      commands: [nativePing],
      argv: ['native_ping', '--json'],
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => undefined,
      exit: (code) => {
        exitCode = code;
      },
      stdin: async () => null,
    });
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ pong: true });

    const nativeInvoker = await createCliInvoker({
      name: 'native-only',
      commands: [nativePing],
    });
    expect(await nativeInvoker.invoke('native_ping', {})).toEqual({
      ok: true,
      exitCode: 0,
      data: { pong: true },
    });

    await expect(
      Promise.resolve(
        callUntyped(createCli, {
          name: 'native-only',
          version: '1.0.0',
          commands: [nativePing],
          lifecycle: {},
          argv: ['native_ping'],
          stdout: () => undefined,
          stderr: () => undefined,
          exit: () => undefined,
        }),
      ),
    ).rejects.toThrow(TypeError);
  });

  test('rejects unknown keys on access, invalid gate.afterHandle, null/undefined CLI configs, and early buildMcpServerFromPrepared', async () => {
    // Unknown key (including beforeHandle) on { open } or { gate } is rejected fail-closed
    expect(() =>
      callUntyped(mountAgent, itemService, {
        access: { open: 'public', beforeHandle: () => undefined },
      }),
    ).toThrow(/mountAgent: access is required/);
    expect(() =>
      callUntyped(mountAgent, itemService, {
        access: { gate: { beforeHandle: () => undefined }, extra: true },
      }),
    ).toThrow(/mountAgent: access is required/);

    // composeToolLifecycle validates argument 0 afterHandle eagerly
    expect(() =>
      callUntyped(composeToolLifecycle, {
        beforeHandle: () => undefined,
        afterHandle: 'not-a-fn',
      }),
    ).toThrow(/composeToolLifecycle: argument 0 afterHandle must be a function/);

    // CLI entrypoints throw access-required TypeError on null/undefined and empty/factory services
    for (const bad of [undefined, null]) {
      await expect(Promise.resolve().then(() => callUntyped(createCli, bad))).rejects.toThrow(
        /createCli: access is required/,
      );
      await expect(
        Promise.resolve().then(() => callUntyped(createCliInvoker, bad)),
      ).rejects.toThrow(/createCliInvoker: access is required/);
      expect(() =>
        callUntyped(buildCliSurface, bad, undefined, {}, new Map(), () => undefined),
      ).toThrow(/buildCliSurface: access is required/);
      expect(() => callUntyped(createCliSession, bad, createCliIo({}))).toThrow(
        /createCliSession: access is required/,
      );
    }
    for (const services of [[], () => [itemService]]) {
      await expect(
        Promise.resolve().then(() =>
          callUntyped(createCli, { name: 'x', version: '1.0.0', services }),
        ),
      ).rejects.toThrow(/createCli: access is required/);
    }

    // buildMcpServerFromPrepared checks access BEFORE calling context(auth) or principal(auth)
    let contextCalled = false;
    const preparedServer = prepareMcpServerSurface({ services: [itemService] });
    expect(() =>
      callUntyped(
        buildMcpServerFromPrepared,
        {
          serverInfo,
          services: [itemService],
          context: () => {
            contextCalled = true;
            return {};
          },
        },
        undefined,
        preparedServer,
      ),
    ).toThrow(/buildMcpServerFromPrepared: access is required/);
    expect(contextCalled).toBe(false);
    expect(() =>
      callUntyped(buildMcpServerFromPrepared, undefined, undefined, preparedServer),
    ).toThrow(/buildMcpServerFromPrepared: access is required/);
  });

  test('access: { inspect: true } allows read-only surface inspection and refuses execution fail-closed before extension, hooks, durability, multi-round, and auth', async () => {
    let handlerCalls = 0;
    let extendResolveCalls = 0;
    let beforeHookCalls = 0;
    let durabilityCalls = 0;
    let authResolveCalls = 0;
    let inputRequiredCalls = 0;

    const trackedContract = defineContract(
      { prefix: '/insp' },
      {
        read: {
          method: 'GET',
          path: '/read',
          desc: 'Inspectable endpoint',
          expose: ['MCP', 'AGENT', 'CLI'],
          tool: {
            name: 'inspect_read',
            mcp: {
              inputRequired: () => {
                inputRequiredCalls += 1;
                return [
                  { key: 'confirm', message: 'enter', schema: z.object({ ok: z.boolean() }) },
                ];
              },
            },
          },
          input: z.object({ id: z.string().min(1) }),
          output: z.object({ id: z.string() }),
        },
      },
    );
    const trackedService = implement(trackedContract, {
      read: async ({ input }) => {
        handlerCalls += 1;
        return { id: input.id };
      },
    });
    const extend = {
      schema: { tenantId: z.string().min(1) },
      resolve: async () => {
        extendResolveCalls += 1;
        return { tenantId: 't1' };
      },
    };
    const hooks = {
      beforeToolCall: () => {
        beforeHookCalls += 1;
      },
    };

    // Rejects invalid inspect shapes and combinations
    for (const badAccess of [
      { inspect: false },
      { inspect: 1 },
      { inspect: 'true' },
      { inspect: true, open: 'public' },
      { inspect: true, gate: { beforeHandle: () => undefined } },
      { inspect: true, afterHandle: () => undefined },
    ]) {
      expect(() => callUntyped(mountAgent, trackedService, { access: badAccess })).toThrow(
        /mountAgent: access is required/,
      );
    }

    // 1. mountAgent: keys/schemas readable, execution fails closed BEFORE durability, extend.resolve, hooks, and arg parsing
    const agentTools = mountAgent(trackedService, {
      access: { inspect: true },
      extend,
      hooks,
      durability: () => {
        durabilityCalls += 1;
        throw new Error('durability must not be called');
      },
    });
    expect(Object.keys(agentTools)).toEqual(['inspect_read']);
    const exec = agentTools.inspect_read?.execute;
    if (!exec) throw new Error('missing execute');
    await expect(
      // Invalid args ({}) must STILL fail with FORBIDDEN, not VALIDATION_ERROR!
      callUntyped(exec, {}, { toolCallId: 'c1', messages: [] }),
    ).rejects.toThrow(/FORBIDDEN|inspect: true/);

    // 2. createToolInvoker: fails closed with FORBIDDEN before extend.resolve and arg parsing
    const invoker = createToolInvoker(trackedService, {
      transport: 'AGENT',
      access: { inspect: true },
      extend,
    });
    const invRes = await invoker.invoke('inspect_read', {}, { hooks });
    expect(invRes).toMatchObject({ ok: false, code: 'FORBIDDEN' });

    const plainTrackedContract = defineContract(
      { prefix: '/plain-insp' },
      {
        read: {
          method: 'GET',
          path: '/read',
          desc: 'Plain inspectable endpoint',
          expose: ['MCP', 'AGENT', 'CLI'],
          tool: { name: 'plain_inspect_read' },
          input: z.object({ id: z.string().min(1) }),
          output: z.object({ id: z.string() }),
        },
      },
    );
    const plainTrackedService = implement(plainTrackedContract, {
      read: async ({ input }) => {
        handlerCalls += 1;
        return { id: input.id };
      },
    });

    // 3. buildMcpServer (with multiRound + runtimeTools) + mountMcp: tools/list succeeds, tools/call refuses FORBIDDEN before resolveMcpRound/inputRequired/handler
    let runtimeToolCalls = 0;
    const trackedRuntimeTool = defineRuntimeTool({
      name: 'inspect_runtime_ping',
      description: 'Tracked inspect runtime tool',
      identity: { serviceName: 'ping', action: 'run', method: 'GET' },
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      expose: ['MCP', 'AGENT', 'CLI'],
      handler: async () => {
        runtimeToolCalls += 1;
        return { ok: true };
      },
    });
    const mcpServer = buildMcpServer({
      serverInfo,
      services: [trackedService],
      runtimeTools: [trackedRuntimeTool],
      access: { inspect: true },
      extend,
      hooks,
      multiRound: {
        state: {
          key: '0123456789abcdef0123456789abcdef',
          principal: () => 'principal',
        },
      },
    });
    const [mcpClientTransport, mcpServerTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: 'inspect-mcp-client', version: '1' });
    try {
      await Promise.all([
        mcpServer.connect(mcpServerTransport),
        mcpClient.connect(mcpClientTransport),
      ]);
      const listed = (await mcpClient.listTools()).tools.map((t) => t.name).sort();
      expect(listed).toEqual(['inspect_read', 'inspect_runtime_ping']);
      const contractCall = await mcpClient.callTool({ name: 'inspect_read', arguments: {} });
      expect(contractCall.isError).toBe(true);
      expect(JSON.stringify(contractCall.content)).toMatch(/FORBIDDEN|inspect: true/);
      const runtimeCall = await mcpClient.callTool({
        name: 'inspect_runtime_ping',
        arguments: {},
      });
      expect(runtimeCall.isError).toBe(true);
      expect(JSON.stringify(runtimeCall.content)).toMatch(/FORBIDDEN|inspect: true/);
    } finally {
      await mcpClient.close();
      await mcpServer.close();
    }

    const bareServer = new McpServer(serverInfo);
    mountMcp(bareServer, plainTrackedService, {
      access: { inspect: true },
      extend,
      hooks,
    });
    const [bareClientTransport, bareServerTransport] = InMemoryTransport.createLinkedPair();
    const bareClient = new Client({ name: 'inspect-bare-client', version: '1' });
    try {
      await Promise.all([
        bareServer.connect(bareServerTransport),
        bareClient.connect(bareClientTransport),
      ]);
      expect((await bareClient.listTools()).tools.map((t) => t.name)).toEqual([
        'plain_inspect_read',
      ]);
      const bareCall = await bareClient.callTool({
        name: 'plain_inspect_read',
        arguments: {},
      });
      expect(bareCall.isError).toBe(true);
      expect(JSON.stringify(bareCall.content)).toMatch(/FORBIDDEN|inspect: true/);
    } finally {
      await bareClient.close();
      await bareServer.close();
    }

    // 4. createCli: --help and --schema succeed without calling resolveAuth; running the command (including invalid args and --dry-run) fails FORBIDDEN before prepareInvocation, validation, stdin, or resolveAuth
    let helpOut = '';
    let helpCode = -1;
    let stdinCalls = 0;
    const forbiddenStdin = async () => {
      stdinCalls += 1;
      throw new Error('stdin must not be read under inspect: true');
    };
    await createCli({
      name: 'inspect-cli',
      version: '1.0.0',
      services: [trackedService],
      access: { inspect: true },
      resolveAuth: () => {
        authResolveCalls += 1;
        return { user: 'u1' };
      },
      argv: ['inspect_read', '--schema'],
      stdout: (s) => {
        helpOut += s;
      },
      stderr: () => undefined,
      exit: (c) => {
        helpCode = c;
      },
    });
    expect(helpCode).toBe(0);
    expect(JSON.parse(helpOut)).toMatchObject({ command: 'inspect_read' });

    for (const cliArgv of [
      ['inspect_read', '--id', 'abc'],
      ['inspect_read'],
      ['inspect_read', '--dry-run'],
    ]) {
      let execErr = '';
      let execCode = -1;
      await createCli({
        name: 'inspect-cli',
        version: '1.0.0',
        services: [trackedService],
        access: { inspect: true },
        resolveAuth: () => {
          authResolveCalls += 1;
          return { user: 'u1' };
        },
        stdin: forbiddenStdin,
        argv: cliArgv,
        stdout: () => undefined,
        stderr: (s) => {
          execErr += s;
        },
        exit: (c) => {
          execCode = c;
        },
      });
      expect(execCode).not.toBe(0);
      expect(execErr).toMatch(/FORBIDDEN|inspect: true/);
    }

    // 5. createCliInvoker: commands readable without resolveAuth or context; invoke fails FORBIDDEN
    let contextCalls = 0;
    const cliInv = await createCliInvoker({
      name: 'inspect-cli',
      services: [trackedService],
      access: { inspect: true },
      context: () => {
        contextCalls += 1;
        return {};
      },
      resolveAuth: () => {
        authResolveCalls += 1;
        return { user: 'u1' };
      },
    });
    expect(cliInv.commands.map((c) => c.name)).toContain('inspect_read');
    const cliInvRes = await cliInv.invoke('inspect_read', {});
    expect(cliInvRes.ok).toBe(false);
    expect(cliInvRes.error?.code).toBe('FORBIDDEN');

    // 6. createDeferredAgentToolSurface.mount accepts { inspect: true } and refuses execution
    const deferredMounted = deferredSurface.mount(makeRunContext(), {
      access: { inspect: true },
    });
    expect(Object.keys(deferredMounted)).toContain('find_tools');
    const findTools = deferredMounted.find_tools;
    if (!findTools?.execute) throw new Error('missing find_tools.execute');
    await expect(
      callUntyped(findTools.execute, { query: 'read' }, { toolCallId: 'c3', messages: [] }),
    ).rejects.toThrow(/FORBIDDEN/);

    expect(handlerCalls).toBe(0);
    expect(runtimeToolCalls).toBe(0);
    expect(extendResolveCalls).toBe(0);
    expect(beforeHookCalls).toBe(0);
    expect(durabilityCalls).toBe(0);
    expect(authResolveCalls).toBe(0);
    expect(contextCalls).toBe(0);
    expect(stdinCalls).toBe(0);
    expect(inputRequiredCalls).toBe(0);
  });
});
