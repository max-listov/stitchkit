import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  CliArgumentError,
  type CliConfig,
  createCli,
  createCliInvoker,
  defineCliCommand,
  extractCliGlobalOptions,
  parseCliArgs,
  type RuntimeToolDefinition,
  routeCliArgv,
  scanCliInvocation,
} from '../src/entrypoints/cli';
import { defineContract } from '../src/entrypoints/contract';
import { implement } from '../src/entrypoints/server';
import { zodObjectFromJsonSchema } from '../src/tools/connections/runtime';
import { coerceJsonArgs } from '../src/tools/schema/coerce';

const appGlobals = z.object({
  profile: z.string().optional(),
  compress: z.boolean().optional(),
  port: z.number().optional(),
});

const inspectInput = z.object({
  text: z.string().optional(),
  verbose: z.boolean().optional(),
  name: z.string().optional(),
});

async function runCli(argv: string[], extra: Partial<CliConfig> = {}) {
  let out = '';
  let err = '';
  let code = -1;
  let calls = 0;
  let lastInput: unknown;
  const inspect = defineCliCommand({
    name: 'inspect',
    description: 'Inspect arguments',
    input: inspectInput,
    output: z.unknown(),
    handler: ({ input }) => {
      calls++;
      lastInput = input;
      return input;
    },
  });
  await createCli({
    name: 'boundary-cli',
    version: '1.0.0',
    globalOptions: appGlobals,
    commands: extra.commands ?? [inspect],
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
    access: extra.access ?? { open: 'local-operator' },
  });
  return { out, err, code, calls, lastInput };
}

describe('CLI boundary unification across all 6 exported helpers', () => {
  test('scanCliInvocation exposes explicit separatedBefore that survives array copying', () => {
    const scan = scanCliInvocation(['inspect', '--verbose', '--profile', 'demo', 'false'], {
      appGlobals,
    });
    expect(scan.command).toBe('inspect');
    expect(scan.globals).toEqual({ profile: 'demo' });
    expect(scan.commandTokens).toEqual(['--verbose', 'false']);
    expect(scan.separatedBefore).toEqual(new Set([1]));

    // Copying commandTokens must NOT lose the separation boundary when passed explicitly.
    const copied = [...scan.commandTokens];
    const parsed = parseCliArgs(copied, inspectInput, {
      separatedBefore: scan.separatedBefore,
    });
    expect(parsed.toolArgs).toEqual({ verbose: true, text: 'false' });
  });

  test('extractCliGlobalOptions agrees with scanCliInvocation and createCli on non-framework options and string --name', async () => {
    // 1. Boolean command flag separated from `false` by lifted app global
    const boolArgv = ['inspect', '--verbose', '--profile', 'demo', 'false'];
    const extractedBool = extractCliGlobalOptions(boolArgv, appGlobals);
    expect(extractedBool.globals).toEqual({ profile: 'demo' });
    expect(extractedBool.argv).toEqual(['inspect', '--verbose', 'false']);
    expect(extractedBool.separatedBefore).toEqual(new Set([2]));

    const cliBool = await runCli(boolArgv);
    expect(cliBool.code).toBe(0);
    expect(cliBool.calls).toBe(1);
    expect(cliBool.lastInput).toEqual({ verbose: true, text: 'false' });

    // The route carries the boundary onto its command argv; no index arithmetic.
    const boolRoute = routeCliArgv(extractedBool.argv, {
      separatedBefore: extractedBool.separatedBefore,
    });
    expect(boolRoute.separatedBefore).toEqual(new Set([1]));
    expect(
      parseCliArgs(boolRoute.commandArgv, inspectInput, {
        separatedBefore: boolRoute.separatedBefore,
      }).toolArgs,
    ).toEqual({ verbose: true, text: 'false' });

    // 2. Command-only slice directly through extractCliGlobalOptions -> parseCliArgs
    const cmdOnly = extractCliGlobalOptions(
      ['--verbose', '--profile', 'demo', 'false'],
      appGlobals,
    );
    expect(cmdOnly.argv).toEqual(['--verbose', 'false']);
    expect(cmdOnly.separatedBefore).toEqual(new Set([1]));
    expect(
      parseCliArgs([...cmdOnly.argv], inspectInput, {
        separatedBefore: cmdOnly.separatedBefore,
      }).toolArgs,
    ).toEqual({ verbose: true, text: 'false' });

    // 3. String --name separated from `false` by lifted app global must NOT emit a bogus boolean error
    const strArgv = ['inspect', '--name', '--profile', 'demo', 'false'];
    const extractedStr = extractCliGlobalOptions(strArgv, appGlobals);
    expect(extractedStr.globals).toEqual({ profile: 'demo' });
    expect(extractedStr.argv).toEqual(['inspect', '--name', 'false']);
    expect(extractedStr.separatedBefore).toEqual(new Set([2]));

    const strRoute = routeCliArgv(extractedStr.argv, {
      separatedBefore: extractedStr.separatedBefore,
    });
    expect(() =>
      parseCliArgs(strRoute.commandArgv, inspectInput, {
        separatedBefore: strRoute.separatedBefore,
      }),
    ).toThrow('--name requires a value');

    const cliStr = await runCli(strArgv);
    expect(cliStr.code).toBe(2);
    expect(cliStr.calls).toBe(0);
    expect(cliStr.err).toContain('--name requires a value');

    // 4. When no boundary is split, separatedBefore is omitted to preserve toEqual shape
    const clean = extractCliGlobalOptions(['--profile', 'demo', 'inspect'], appGlobals);
    expect(clean).toEqual({ argv: ['inspect'], globals: { profile: 'demo' } });
    expect('separatedBefore' in clean).toBe(false);

    // 5. Top-level --help separated from `false` by lifted app global does NOT trigger bogus boolean refusal
    const topHelpExtracted = extractCliGlobalOptions(
      ['--help', '--profile', 'demo', 'false'],
      appGlobals,
    );
    expect(topHelpExtracted.argv).toEqual(['--help', 'false']);
    expect(topHelpExtracted.globals).toEqual({ profile: 'demo' });

    // 6. Bare FRAMEWORK boolean separated from true/false by lifted global still refuses (ADR 0310)
    const fwExtracted = extractCliGlobalOptions(
      ['inspect', '--dry-run', '--profile', 'demo', 'false'],
      appGlobals,
    );
    expect(fwExtracted.globals).toEqual({ profile: 'demo' });
    expect(fwExtracted.argv).toEqual([]);
    expect(fwExtracted.error).toBeInstanceOf(CliArgumentError);
    expect(fwExtracted.error?.message).toContain(
      'Bare --dry-run cannot be separated from "false"',
    );
  });

  test('framework-only flags without a command and without defaultCommand never become command names', async () => {
    for (const argv of [
      ['--help=true'],
      ['--help=yes'],
      ['--help=1'],
      ['--help=false'],
      ['--json'],
      ['--quiet'],
    ]) {
      const scan = scanCliInvocation(argv, { appGlobals });
      expect(scan.command).toBeUndefined();
      expect(scan.topLevelHelp).toBe(true);

      const route = routeCliArgv(argv);
      expect(route.command).toBeUndefined();
      expect(route.topLevelHelp).toBe(true);

      const res = await runCli(argv);
      expect(res.code).toBe(0);
      expect(res.err).toBe('');
      expect(res.calls).toBe(0);
      expect(res.out).toContain('Usage: boundary-cli');
    }

    // Invalid framework-only invocations without a command still refuse with exit 2 (not help)
    for (const bad of [['--json=maybe'], ['--sort'], ['--json', '--json']]) {
      const badScan = scanCliInvocation(bad, { appGlobals });
      expect(badScan.error).toBeInstanceOf(CliArgumentError);
      expect(badScan.command).toBeUndefined();
      expect(badScan.commandTokens).toEqual([]);
      const res = await runCli(bad);
      expect(res.code).toBe(2);
      expect(res.out).toBe('');
      expect(res.calls).toBe(0);
    }

    // Control: --help=true BEFORE an explicit command still requests command help (not top-level help)
    const cmdHelp = await runCli(['--help=true', 'inspect']);
    expect(cmdHelp.code).toBe(0);
    expect(cmdHelp.out).toContain('Usage: boundary-cli inspect');
  });

  test('--schema --schema=false refuses duplicate instead of swallowing error in early check', async () => {
    for (const argv of [
      ['inspect', '--schema', '--schema=false'],
      ['inspect', '--schema', '--schema'],
      ['inspect', '--schema=false', '--schema'],
      ['inspect', '--schema', '--schema=maybe'],
      ['inspect', '--schema', '--schema:=true'],
      ['inspect', '--schema:=true', '--schema'],
      ['inspect', '--schema:=false', '--schema'],
      ['--schema:=true', 'inspect', '--schema'],
      ['inspect', '--schema=maybe', '--schema'],
    ]) {
      const scan = scanCliInvocation(argv, { appGlobals });
      expect(scan.error).toBeInstanceOf(CliArgumentError);
      expect(scan.command).toBeUndefined();
      expect(scan.commandTokens).toEqual([]);
      const res = await runCli(argv);
      expect(res.code).toBe(2);
      expect(res.out).toBe('');
      expect(res.calls).toBe(0);
      expect(res.err).toContain('--schema');
    }

    expect(() => parseCliArgs(['--schema', '--schema=false'], inspectInput)).toThrow(
      '--schema was passed 2 times',
    );

    // --help still wins over malformed --schema combination regardless of order
    for (const argv of [
      ['inspect', '--schema', '--schema=false', '--help'],
      ['inspect', '--schema:=true', '--schema', '--help'],
    ]) {
      const helpWins = await runCli(argv);
      expect(helpWins.code).toBe(0);
      expect(helpWins.out).toContain('Usage: boundary-cli inspect');
    }
  });

  test('malformed app global values before --help/--version/--schema show early output while duplicates still refuse before help', async () => {
    const malformedCases: Array<{
      badTokens: string[];
      errorPattern: RegExp;
    }> = [
      {
        badTokens: ['--compress=maybe'],
        errorPattern: /--compress expects a boolean/,
      },
      {
        badTokens: ['--port', 'abc'],
        errorPattern: /--port expects a number/,
      },
      {
        badTokens: ['--profile:=not-json'],
        errorPattern: /--profile expects valid JSON/,
      },
    ];

    for (const { badTokens, errorPattern } of malformedCases) {
      const topHelpArgv = [...badTokens, '--help'];
      const topScan = scanCliInvocation(topHelpArgv, { appGlobals });
      expect(topScan.topLevelHelp).toBe(true);

      const topCli = await runCli(topHelpArgv);
      expect(topCli.code).toBe(0);
      expect(topCli.err).toBe('');
      expect(topCli.out).toContain('Usage: boundary-cli');

      const cmdHelpCli = await runCli(['inspect', ...badTokens, '--help']);
      expect(cmdHelpCli.code).toBe(0);
      expect(cmdHelpCli.err).toBe('');
      expect(cmdHelpCli.out).toContain('Usage: boundary-cli inspect');

      const verCli = await runCli([...badTokens, '--version']);
      expect(verCli.code).toBe(0);
      expect(verCli.out).toBe('boundary-cli 1.0.0\n');

      const schemaCli = await runCli(['inspect', ...badTokens, '--schema']);
      expect(schemaCli.code).toBe(0);
      expect(JSON.parse(schemaCli.out)).toMatchObject({ command: 'inspect' });

      // extractCliGlobalOptions answers like createCli: help reports no global's error.
      expect(extractCliGlobalOptions(topHelpArgv, appGlobals)).toEqual({
        argv: ['--help'],
        globals: {},
      });
      const badExtract = extractCliGlobalOptions([...badTokens, 'inspect'], appGlobals);
      expect(badExtract.argv).toEqual([]);
      expect(badExtract.error).toBeInstanceOf(CliArgumentError);
      expect(badExtract.error?.message).toMatch(errorPattern);

      // Non-early invocations (both with command and commandless) still refuse with exit 2
      for (const nonEarlyArgv of [[...badTokens, 'inspect'], badTokens]) {
        const badScan = scanCliInvocation(nonEarlyArgv, { appGlobals });
        expect(badScan.error).toBeInstanceOf(CliArgumentError);
        expect(badScan.error?.message).toMatch(errorPattern);
        expect(badScan.command).toBeUndefined();
        expect(badScan.commandTokens).toEqual([]);
        const failed = await runCli(nonEarlyArgv);
        expect(failed.code).toBe(2);
        expect(failed.calls).toBe(0);
        expect(failed.err).toMatch(errorPattern);
      }
    }

    // Application global repetition refuses eagerly even when --help is requested
    const dupHelpArgv = ['--profile', 'a', '--profile', 'b', '--help'];
    const dupScan = scanCliInvocation(dupHelpArgv, { appGlobals });
    expect(dupScan.error).toBeInstanceOf(CliArgumentError);
    expect(dupScan.error?.message).toMatch(/--profile was passed 2 times/);
    const dupExtract = extractCliGlobalOptions(dupHelpArgv, appGlobals);
    expect(dupExtract.argv).toEqual([]);
    expect(dupExtract.error).toBeInstanceOf(CliArgumentError);
    expect(dupExtract.error?.message).toMatch(/--profile was passed 2 times/);
    const dupHelpCli = await runCli(dupHelpArgv);
    expect(dupHelpCli.code).toBe(2);
    expect(dupHelpCli.out).toBe('');
    expect(dupHelpCli.calls).toBe(0);
    expect(dupHelpCli.err).toContain('--profile was passed 2 times');
  });

  test('missing app global value before --help shows help in createCli, scanCliInvocation and extractCliGlobalOptions', async () => {
    const topScan = scanCliInvocation(['--profile', '--help'], { appGlobals });
    expect(topScan.topLevelHelp).toBe(true);

    const topCli = await runCli(['--profile', '--help']);
    expect(topCli.code).toBe(0);
    expect(topCli.err).toBe('');
    expect(topCli.out).toContain('Usage: boundary-cli');

    const cmdCli = await runCli(['inspect', '--profile', '--help']);
    expect(cmdCli.code).toBe(0);
    expect(cmdCli.err).toBe('');
    expect(cmdCli.out).toContain('Usage: boundary-cli inspect');

    const verCli = await runCli(['--profile', '--version']);
    expect(verCli.code).toBe(0);
    expect(verCli.out).toBe('boundary-cli 1.0.0\n');

    // extractCliGlobalOptions lifts nothing and leaves the help request to route.
    expect(extractCliGlobalOptions(['--profile', '--help'], appGlobals)).toEqual({
      argv: ['--help'],
      globals: {},
    });
    const missingExtract = extractCliGlobalOptions(
      ['--profile', '--json', 'inspect'],
      appGlobals,
    );
    expect(missingExtract.argv).toEqual([]);
    expect(missingExtract.error).toBeInstanceOf(CliArgumentError);
    expect(missingExtract.error?.message).toContain('--profile requires a value');

    // Without --help, missing app global value still exits 2
    const missingCli = await runCli(['--profile', '--json', 'inspect']);
    expect(missingCli.code).toBe(2);
    expect(missingCli.err).toContain('--profile requires a value');
  });

  test('pure-boolean command flag --verbose=maybe exits 2 on native, managed and discovered commands and in parseCliArgs while preserving unions', async () => {
    // 1. Native command
    const nativeRes = await runCli(['inspect', '--verbose=maybe']);
    expect(nativeRes.code).toBe(2);
    expect(nativeRes.calls).toBe(0);
    expect(nativeRes.err).toContain('--verbose expects a boolean (true/false), got "maybe"');

    // 2. Managed contract command
    let managedCalls = 0;
    const contract = defineContract(
      { prefix: 'bool', scope: 'public' },
      {
        check: {
          method: 'POST',
          path: '/check',
          desc: 'Check boolean flag',
          expose: ['CLI'],
          input: z.object({ verbose: z.boolean().optional() }),
          output: z.object({ verbose: z.boolean().optional() }),
          tool: { name: 'check' },
        },
      },
    );
    const service = implement(contract, {
      check: ({ input }) => {
        managedCalls++;
        return input;
      },
    });
    const managedRes = await runCli(['check', '--verbose=maybe'], {
      commands: [],
      services: [service],
    });
    expect(managedRes.code).toBe(2);
    expect(managedCalls).toBe(0);
    expect(managedRes.err).toContain('--verbose expects a boolean (true/false), got "maybe"');

    // 3. Discovered-from-JSON-Schema command
    let discoveredCalls = 0;
    const discoveredTool: RuntimeToolDefinition = {
      name: 'remote_check',
      description: 'Discovered boolean check',
      identity: { serviceName: 'remote', action: 'check', method: 'POST' },
      expose: ['CLI'],
      input: zodObjectFromJsonSchema({
        type: 'object',
        properties: { verbose: { type: 'boolean' } },
      }),
      output: z.unknown(),
      handler: ({ input }) => {
        discoveredCalls++;
        return input;
      },
    };
    const discoveredRes = await runCli(['remote_check', '--verbose=maybe'], {
      commands: [],
      runtimeTools: [discoveredTool],
    });
    expect(discoveredRes.code).toBe(2);
    expect(discoveredCalls).toBe(0);
    expect(discoveredRes.err).toContain(
      '--verbose expects a boolean (true/false), got "maybe"',
    );

    // 4. Union boolean|string (field-level AND object-level) stays accepted!
    const fieldUnionCmd = defineCliCommand({
      name: 'field_union',
      description: 'Field union boolean or string',
      input: z.object({ verbose: z.union([z.boolean(), z.string()]) }),
      output: z.unknown(),
      handler: ({ input }) => input,
    });
    const objUnionContract = defineContract(
      { prefix: 'union', scope: 'public' },
      {
        run: {
          method: 'POST',
          path: '/run',
          desc: 'Object union boolean or string',
          expose: ['CLI'],
          input: z.union([
            z.object({ verbose: z.boolean() }),
            z.object({ verbose: z.string() }),
          ]),
          output: z.unknown(),
          tool: { name: 'obj_union' },
        },
      },
    );
    const objUnionService = implement(objUnionContract, {
      run: ({ input }) => input,
    });
    const fieldUnionRes = await runCli(['field_union', '--verbose=maybe', '--json'], {
      commands: [fieldUnionCmd],
    });
    expect(fieldUnionRes).toMatchObject({ code: 0, err: '', out: '{"verbose":"maybe"}\n' });
    const objUnionRes = await runCli(['obj_union', '--verbose=maybe', '--json'], {
      commands: [],
      services: [objUnionService],
    });
    expect(objUnionRes).toMatchObject({ code: 0, err: '', out: '{"verbose":"maybe"}\n' });

    // 4b. Short alias `-v=maybe` on object-level union matches `--verbose=maybe`, while pure boolean `-c=banana` still refuses
    const objUnionSchema = z.union([
      z.object({ verbose: z.boolean() }),
      z.object({ verbose: z.string() }),
    ]);
    expect(
      parseCliArgs(['-v=maybe'], objUnionSchema, { aliases: new Map([['v', 'verbose']]) })
        .toolArgs,
    ).toEqual({ verbose: 'maybe' });

    const objUnionAliasRes = await runCli(['obj_union', '-v=maybe', '--json'], {
      commands: [],
      services: [objUnionService],
      commandSettings: { obj_union: { aliases: { v: 'verbose' } } },
    });
    expect(objUnionAliasRes).toMatchObject({ code: 0, err: '', out: '{"verbose":"maybe"}\n' });

    expect(() =>
      parseCliArgs(['-c=banana'], z.object({ compress: z.boolean() }), {
        aliases: new Map([['c', 'compress']]),
      }),
    ).toThrow('--compress expects a boolean (true/false), got "banana"');

    const pureBoolAliasRes = await runCli(['inspect', '-v=banana'], {
      commandSettings: { inspect: { aliases: { v: 'verbose' } } },
    });
    expect(pureBoolAliasRes.code).toBe(2);
    expect(pureBoolAliasRes.calls).toBe(0);
    expect(pureBoolAliasRes.err).toContain(
      '--verbose expects a boolean (true/false), got "banana"',
    );

    // 5. Direct parseCliArgs reads the command line's grammar: the same refusal
    expect(() =>
      parseCliArgs(['--active=banana'], z.object({ active: z.boolean().optional() })),
    ).toThrow('--active expects a boolean (true/false), got "banana"');
  });

  test('createCliInvoker validates duplicate commands and native commandSettings without breaking ADR 0296', async () => {
    const pingA = defineCliCommand({
      name: 'ping',
      description: 'Ping A',
      input: z.object({ target: z.string().optional(), verbose: z.boolean().optional() }),
      output: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    });
    const pingB = defineCliCommand({
      name: 'ping',
      description: 'Ping B',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    });

    // Duplicate native commands are refused
    await expect(
      createCliInvoker({ name: 'dup-native', commands: [pingA, pingB] }),
    ).rejects.toThrow(/Duplicate CLI command "ping"/);

    // Duplicate native vs managed command is refused
    const managedPing: RuntimeToolDefinition = {
      name: 'ping',
      description: 'Managed ping',
      identity: { serviceName: 'svc', action: 'ping', method: 'GET' },
      expose: ['CLI'],
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    };
    await expect(
      createCliInvoker({
        name: 'dup-mixed',
        access: { open: 'local-operator' },
        commands: [pingA],
        runtimeTools: [managedPing],
      }),
    ).rejects.toThrow(/Duplicate CLI command "ping"/);

    // Invalid commandSettings on native command are refused (alias to unknown field, boolean positional, alias+passthrough clash)
    await expect(
      createCliInvoker({
        name: 'bad-alias',
        commands: [pingA],
        commandSettings: { ping: { aliases: { x: 'missing' } } },
      }),
    ).rejects.toThrow(/targets unknown field "missing"/);

    await expect(
      createCliInvoker({
        name: 'bad-pos',
        commands: [pingA],
        commandSettings: { ping: { positionals: ['verbose'] } },
      }),
    ).rejects.toThrow(/boolean field "verbose" cannot be positional/);

    await expect(
      createCliInvoker({
        name: 'bad-passthrough-alias',
        commands: [pingA],
        commandSettings: { ping: { aliases: { t: 'target' }, passthrough: 'target' } },
      }),
    ).rejects.toThrow(/cannot alias passthrough field "target"/);

    // ADR 0296 preserved: reserved shell name and global-shadowed fields still work in-process
    const quietNative = defineCliCommand({
      name: '--quiet',
      description: 'Exact name',
      input: z.object({ text: z.string() }),
      output: z.object({ text: z.string() }),
      handler: ({ input }) => input,
    });
    const okInvoker = await createCliInvoker({
      name: 'in-process',
      commands: [quietNative],
    });
    expect(await okInvoker.invoke('--quiet', { text: 'ok' })).toEqual({
      ok: true,
      exitCode: 0,
      data: { text: 'ok' },
    });
  });

  test('ZodReadonly fields and root schemas coerce and validate properly, including discovered JSON Schema readOnly', async () => {
    const readonlySchema = z
      .object({
        verbose: z.boolean().readonly().optional(),
        count: z.number().int().readonly().optional(),
        items: z.array(z.number().readonly()).readonly().optional(),
        text: z.string().readonly().optional(),
      })
      .readonly();

    expect(
      parseCliArgs(
        ['--verbose', '--count', '7', '--items', '1', '--items', '2', '--text', 'hello'],
        readonlySchema,
      ).toolArgs,
    ).toEqual({
      verbose: true,
      count: 7,
      items: [1, 2],
      text: 'hello',
    });
    expect(() => parseCliArgs(['--items', '1', 'hello'], readonlySchema)).toThrow(
      '--items cannot be combined with automatic positional arguments',
    );
    expect(() => parseCliArgs(['--count', '3.5'], readonlySchema)).toThrow(
      '--count expects a whole number, got "3.5"',
    );

    // Discovered JSON Schema with `readOnly: true` produces ZodReadonly
    const discoveredReadOnly = zodObjectFromJsonSchema({
      type: 'object',
      readOnly: true,
      properties: {
        verbose: { type: 'boolean', readOnly: true },
        count: { type: 'integer', readOnly: true },
        text: { type: 'string', readOnly: true },
      },
    });
    expect(
      parseCliArgs(['--verbose', '--count', '5', 'hi'], discoveredReadOnly).toolArgs,
    ).toEqual({ verbose: true, count: 5, text: 'hi' });

    const roTool: RuntimeToolDefinition = {
      name: 'ro_cmd',
      description: 'Readonly discovered command',
      identity: { serviceName: 'remote', action: 'ro', method: 'GET' },
      expose: ['CLI'],
      input: discoveredReadOnly,
      output: z.unknown(),
      handler: ({ input }) => input,
    };
    const okRo = await runCli(['ro_cmd', '--verbose', '--count', '5', 'hi', '--json'], {
      commands: [],
      runtimeTools: [roTool],
    });
    expect(okRo.code).toBe(0);
    expect(okRo.err).toBe('');
    expect(JSON.parse(okRo.out)).toEqual({ verbose: true, count: 5, text: 'hi' });
    const badRoBool = await runCli(['ro_cmd', '--verbose=maybe'], {
      commands: [],
      runtimeTools: [roTool],
    });
    expect(badRoBool.code).toBe(2);
    expect(badRoBool.err).toContain('--verbose expects a boolean (true/false), got "maybe"');

    // Nested ZodReadonly objects and arrays coerce JSON strings through parseCliArgs, coerceJsonArgs and createCli
    const readonlyNested = z
      .object({
        meta: z.object({ a: z.number() }).readonly(),
        tags: z.array(z.string()).readonly().optional(),
      })
      .readonly();
    const parsedNested = parseCliArgs(
      ['--meta', '{"a":42}', '--tags', '["x","y"]'],
      readonlyNested,
    ).toolArgs;
    expect(coerceJsonArgs(parsedNested, readonlyNested)).toEqual({
      meta: { a: 42 },
      tags: ['x', 'y'],
    });
    expect(
      readonlyNested.safeParse(coerceJsonArgs(parsedNested, readonlyNested)).success,
    ).toBe(true);

    const roNestedContract = defineContract(
      { prefix: 'ronested', scope: 'public' },
      {
        run: {
          method: 'POST',
          path: '/run',
          desc: 'Readonly nested object and array coercion',
          expose: ['CLI'],
          input: readonlyNested,
          output: z.unknown(),
          tool: { name: 'ro_nested' },
        },
      },
    );
    const roNestedService = implement(roNestedContract, {
      run: ({ input }) => input,
    });
    const roNestedRes = await runCli(
      ['ro_nested', '--meta', '{"a":42}', '--tags', '["x","y"]', '--json'],
      { commands: [], services: [roNestedService] },
    );
    expect(roNestedRes).toMatchObject({
      code: 0,
      err: '',
      out: '{"meta":{"a":42},"tags":["x","y"]}\n',
    });

    // Union of string and readonly array refuses list-written-as-text via unwrapped arrayMembers
    const roUnionSchema = z.object({
      items: z.union([z.string(), z.array(z.number()).readonly()]),
    });
    expect(() => coerceJsonArgs({ items: '[1,2]' }, roUnionSchema)).toThrow(
      /is a list written as text/,
    );
  });

  test('explicit no-<bool> field beside <bool> is not shadowed by --no-<bool> negation', async () => {
    const stringNoCache = z.object({
      cache: z.boolean().optional(),
      'no-cache': z.string().optional(),
    });
    expect(parseCliArgs(['--no-cache', 'stale'], stringNoCache).toolArgs).toEqual({
      'no-cache': 'stale',
    });

    const boolNoCache = z.object({
      cache: z.boolean().optional(),
      'no-cache': z.boolean().optional(),
    });
    expect(parseCliArgs(['--no-cache', '--cache=false'], boolNoCache).toolArgs).toEqual({
      'no-cache': true,
      cache: false,
    });

    // Control: when `no-cache` is NOT declared, --no-cache still negates `cache`
    const cacheOnly = z.object({ cache: z.boolean().optional() });
    expect(parseCliArgs(['--no-cache'], cacheOnly).toolArgs).toEqual({ cache: false });

    // Discovered JSON Schema command with both `cache` and `no-cache`
    const discoveredNoCache: RuntimeToolDefinition = {
      name: 'fetch_item',
      description: 'Fetch with explicit no-cache field',
      identity: { serviceName: 'remote', action: 'fetch', method: 'GET' },
      expose: ['CLI'],
      input: zodObjectFromJsonSchema({
        type: 'object',
        properties: {
          cache: { type: 'boolean' },
          'no-cache': { type: 'string' },
        },
      }),
      output: z.unknown(),
      handler: ({ input }) => input,
    };
    const res = await runCli(['fetch_item', '--no-cache', 'bypass', '--json'], {
      commands: [],
      runtimeTools: [discoveredNoCache],
    });
    expect(res).toMatchObject({ code: 0, err: '', out: '{"no-cache":"bypass"}\n' });
  });
});
