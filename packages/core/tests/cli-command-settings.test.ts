import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  type CliCommandName,
  type CliConfig,
  createCli,
  createCliInvoker,
  defineCliCommand,
  defineCliResult,
  type RuntimeToolDefinition,
} from '../src/entrypoints/cli';
import { defineContract } from '../src/entrypoints/contract';
import { implement, type ServiceDef } from '../src/entrypoints/server';
import { buildCliSurface } from '../src/tools/cli/invoke';
import { createCliIo } from '../src/tools/cli/io';
import { createCliSession } from '../src/tools/cli/session';

const OutputSchema = z.object({ ok: z.boolean() });

const demoContract = defineContract(
  { prefix: '/demo' },
  {
    run: {
      method: 'POST',
      path: '/run',
      desc: 'Run a demo command',
      expose: ['CLI'],
      tool: { name: 'demo_run' },
      input: z.object({
        target: z.string(),
        verbose: z.boolean().optional(),
        extra: z.record(z.string(), z.unknown()).optional(),
      }),
      output: OutputSchema,
    },
  },
);

const demoService = implement(demoContract, {
  run: async () => ({ ok: true }),
});

async function runDemo(argv: string[], extra: Partial<CliConfig> = {}) {
  let out = '';
  let err = '';
  let code = -1;
  await createCli({
    name: 'demo',
    version: '1.0.0',
    argv,
    stdin: async () => null,
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    exit: (value) => {
      code = value;
    },
    ...extra,
    services: extra.services ?? [demoService],
    access: extra.access ?? { open: 'local-operator' },
  });
  return { out, err, code };
}

describe('CLI commandSettings validation and legacy key refusal', () => {
  test('typo in command name fails with CLI policy targets unavailable command for all five settings', async () => {
    const cases = [
      { positionals: ['target'] },
      { aliases: { v: 'verbose' } },
      { result: defineCliResult(OutputSchema, { exitCode: () => 0 }) },
      { passthrough: 'extra' },
      {
        wait: {
          tool: 'demo_run',
          poll: () => ({ target: 'a' }),
          done: () => true,
        },
      },
    ] as const;

    for (const setting of cases) {
      await expect(
        runDemo(['demo_run', 'hello'], {
          commandSettings: { typo_cmd: setting },
        }),
      ).rejects.toThrow('CLI policy targets unavailable command "typo_cmd"');
    }
  });

  test('valid commandSettings configures aliases, positionals, passthrough, result and wait together', async () => {
    let seenInput: unknown;
    const service = implement(demoContract, {
      run: async ({ input }) => {
        seenInput = input;
        return { ok: true };
      },
    });
    const res = await runDemo(['demo_run', 'hello', '-v', '--flag', '12'], {
      services: [service],
      commandSettings: {
        demo_run: {
          positionals: ['target'],
          aliases: { v: 'verbose' },
          passthrough: 'extra',
          result: defineCliResult(OutputSchema, {
            present: ({ result }) => `ok=${result.ok}\n`,
            exitCode: () => 0,
          }),
          wait: {
            tool: 'demo_run',
            poll: () => ({ target: 'hello' }),
            done: () => true,
          },
        },
      },
    });
    expect(res.code).toBe(0);
    expect(res.out).toBe('ok=true\n');
    expect(seenInput).toEqual({
      target: 'hello',
      verbose: true,
      extra: { flag: 12 },
    });
  });

  test('each of the five removed top-level keys throws TypeError mentioning commandSettings across all entrypoints', async () => {
    const legacyEntries: ReadonlyArray<readonly [string, unknown]> = [
      ['optionAliases', { demo_run: { v: 'verbose' } }],
      ['positionals', { demo_run: ['target'] }],
      ['results', { demo_run: defineCliResult(OutputSchema, {}) }],
      ['passthrough', { demo_run: 'extra' }],
      [
        'wait',
        {
          demo_run: {
            tool: 'demo_run',
            poll: () => ({ target: 'a' }),
            done: () => true,
          },
        },
      ],
    ];

    for (const [key, value] of legacyEntries) {
      const baseConfig: CliConfig = {
        name: 'demo',
        version: '1.0.0',
        services: [demoService],
        access: { open: 'local-operator' },
        argv: ['demo_run', 'a'],
        stdin: async () => null,
        stdout: () => undefined,
        stderr: () => undefined,
        exit: () => undefined,
      };
      const legacyConfig: CliConfig = Object.assign(baseConfig, { [key]: value });

      await expect(createCli(legacyConfig)).rejects.toThrow(TypeError);
      await expect(createCli(legacyConfig)).rejects.toThrow('commandSettings');

      await expect(createCliInvoker(legacyConfig)).rejects.toThrow(TypeError);
      await expect(createCliInvoker(legacyConfig)).rejects.toThrow('commandSettings');

      expect(() => createCliSession(legacyConfig, createCliIo(legacyConfig))).toThrow(
        TypeError,
      );
      expect(() => createCliSession(legacyConfig, createCliIo(legacyConfig))).toThrow(
        'commandSettings',
      );

      expect(() => buildCliSurface(legacyConfig, undefined, {}, new Map(), new Set())).toThrow(
        TypeError,
      );
      expect(() => buildCliSurface(legacyConfig, undefined, {}, new Map(), new Set())).toThrow(
        'commandSettings',
      );
    }

    // Even an explicit `undefined` value on a removed top-level key is refused loudly.
    const undefinedLegacy: CliConfig = Object.assign(
      {
        name: 'demo',
        version: '1.0.0',
        services: [demoService],
        access: { open: 'local-operator' },
        argv: ['demo_run', 'a'],
        stdin: async () => null,
        stdout: () => undefined,
        stderr: () => undefined,
        exit: () => undefined,
      } satisfies CliConfig,
      { optionAliases: undefined },
    );
    await expect(createCli(undefinedLegacy)).rejects.toThrow(TypeError);
    await expect(createCli(undefinedLegacy)).rejects.toThrow('commandSettings');
    await expect(createCliInvoker(undefinedLegacy)).rejects.toThrow(TypeError);
  });

  test('createCliInvoker accepts commandSettings on native commands and refuses result on them', async () => {
    const returningNative = defineCliCommand({
      name: 'ping',
      description: 'Return pong',
      input: z.object({
        target: z.string().default('local'),
        verbose: z.boolean().optional(),
      }),
      output: OutputSchema,
      handler: () => ({ ok: true }),
    });
    const printingNative = defineCliCommand({
      name: 'banner',
      description: 'Print banner',
      input: z.object({ loud: z.boolean().optional() }),
      handler: ({ stdout }) => {
        stdout('hi\n');
      },
    });

    const invoker = await createCliInvoker({
      name: 'demo',
      services: [demoService],
      access: { open: 'local-operator' },
      commands: [returningNative, printingNative],
      commandSettings: {
        ping: { aliases: { v: 'verbose' }, positionals: ['target'] },
        banner: { aliases: { l: 'loud' } },
      },
    });
    expect(invoker.commands.map((c) => c.name)).toEqual(['ping', 'demo_run']);
    expect(await invoker.invoke('ping', { target: 'host' })).toEqual({
      ok: true,
      exitCode: 0,
      data: { ok: true },
    });
    expect((await invoker.invoke('banner', {})).error?.code).toBe('UNKNOWN_OPERATION');

    await expect(
      createCliInvoker({
        name: 'demo',
        services: [demoService],
        access: { open: 'local-operator' },
        commands: [returningNative],
        commandSettings: {
          ping: { result: defineCliResult(OutputSchema, { exitCode: () => 0 }) },
        },
      }),
    ).rejects.toThrow('not managed');
  });

  test('native-only CLI validates commandSettings typos and refuses result policies at startup', async () => {
    const pingNative = defineCliCommand({
      name: 'ping',
      description: 'Return pong',
      input: z.object({ verbose: z.boolean().optional() }),
      output: OutputSchema,
      handler: () => ({ ok: true }),
    });

    await expect(
      createCli({
        name: 'native-only',
        version: '1.0.0',
        commands: [pingNative],
        commandSettings: { typo_native: { aliases: { v: 'verbose' } } },
        argv: ['ping'],
        stdin: async () => null,
        stdout: () => undefined,
        stderr: () => undefined,
        exit: () => undefined,
      }),
    ).rejects.toThrow('CLI policy targets unavailable command "typo_native"');

    await expect(
      createCli({
        name: 'native-only',
        version: '1.0.0',
        commands: [pingNative],
        commandSettings: {
          ping: { result: defineCliResult(OutputSchema, { exitCode: () => 0 }) },
        },
        argv: ['ping'],
        stdin: async () => null,
        stdout: () => undefined,
        stderr: () => undefined,
        exit: () => undefined,
      }),
    ).rejects.toThrow('not managed');
  });

  test('CliCommandName narrows static literal surfaces and widens dynamic or wide sources to string', async () => {
    const staticRuntimeTool = {
      name: 'status' as const,
      description: 'Check status',
      identity: { serviceName: 'demo', action: 'status', method: 'GET' as const },
      input: z.object({ verbose: z.boolean().optional() }),
      output: OutputSchema,
      expose: ['CLI'] as const,
      handler: async () => ({ ok: true }),
    };

    // Compile-time checks: static literal runtime tool narrows commandSettings keys.
    type StaticName = CliCommandName<undefined, readonly [typeof staticRuntimeTool]>;
    const okName: StaticName = 'status';
    // @ts-expect-error — typo is rejected on static literal runtime tools
    const badName: StaticName = 'statu';
    expect(okName).toBe('status');
    expect<string>(badName).toBe('statu');

    // Factory source widens to string.
    type FactoryName = CliCommandName<
      (auth: unknown, globals: { socket?: string }) => readonly ServiceDef[],
      undefined
    >;
    const discoveredName: FactoryName = 'any_discovered_tool';
    expect(discoveredName).toBe('any_discovered_tool');

    // Wide ServiceDef[] array widens to string.
    type WideServiceName = CliCommandName<readonly ServiceDef[], undefined>;
    const wideName: WideServiceName = 'any_service_tool';
    expect(wideName).toBe('any_service_tool');

    // Contextual typing of globals on services factory + static runtime commandSettings narrowing.
    let seenSocket: string | undefined;
    let code = -1;
    await createCli({
      name: 'typed-demo',
      version: '1.0.0',
      globalOptions: z.object({ socket: z.string().optional() }),
      services: (_auth, globals) => {
        seenSocket = globals.socket;
        return [demoService];
      },
      access: { open: 'local-operator' },
      commandSettings: {
        demo_run: { aliases: { v: 'verbose' } },
      },
      argv: ['--socket', '/tmp/a.sock', 'demo_run', 'x'],
      stdin: async () => null,
      stdout: () => undefined,
      stderr: () => undefined,
      exit: (value) => {
        code = value;
      },
    });
    expect(code).toBe(0);
    expect(seenSocket).toBe('/tmp/a.sock');

    // Static runtime tool rejects unknown commandSettings key at compile time.
    const staticCheck = () =>
      createCli({
        name: 'static-runtime',
        version: '1.0.0',
        runtimeTools: [staticRuntimeTool] as const,
        access: { open: 'local-operator' },
        commandSettings: {
          status: { aliases: { v: 'verbose' } },
          // @ts-expect-error — unknown command name rejected for static literal runtimeTools
          statu: { aliases: { v: 'verbose' } },
        },
        argv: ['status'],
      });
    expect(typeof staticCheck).toBe('function');

    // Native command in `commands` keeps runtime tool + native commandSettings compatible.
    const pingCmd = defineCliCommand({
      name: 'ping',
      description: 'Ping',
      input: z.object({}),
      output: OutputSchema,
      handler: () => ({ ok: true }),
    });
    const mixedRuntime: readonly RuntimeToolDefinition[] = [staticRuntimeTool];
    let mixedCode = -1;
    await createCli({
      name: 'mixed',
      version: '1.0.0',
      runtimeTools: mixedRuntime,
      access: { open: 'local-operator' },
      commands: [pingCmd],
      commandSettings: {
        status: { aliases: { v: 'verbose' } },
      },
      argv: ['status'],
      stdin: async () => null,
      stdout: () => undefined,
      stderr: () => undefined,
      exit: (value) => {
        mixedCode = value;
      },
    });
    expect(mixedCode).toBe(0);
  });
});
