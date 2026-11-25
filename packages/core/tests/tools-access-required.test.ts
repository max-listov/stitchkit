import { describe, expect, test } from 'bun:test';
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
});
