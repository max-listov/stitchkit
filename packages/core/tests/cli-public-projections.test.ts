/**
 * One grammar: every public projection of the CLI parser answers a line the way
 * `createCli` does. An entry point that lifts its globals, routes and parses argv
 * itself (`extractCliGlobalOptions` → `routeCliArgv` → `parseCliArgs` →
 * `createCliInvoker`) must reach the same exit code, the same output, the same
 * refusal and the same number of handler calls as the program that hands the whole
 * line to `createCli`.
 */
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

const appGlobals = z.object({
  profile: z.string().optional(),
  compress: z.boolean().optional(),
});

const input = z.object({
  text: z.string().optional(),
  verbose: z.boolean().optional(),
  name: z.string().optional(),
  count: z.number().optional(),
});

let calls = 0;
let seen: unknown;

const inspect = defineCliCommand({
  name: 'inspect',
  description: 'Inspect the arguments',
  input,
  output: z.unknown(),
  handler: ({ input: args }) => {
    calls++;
    seen = args;
    return args;
  },
});

const lookup: RuntimeToolDefinition = {
  name: 'lookup',
  description: 'Managed lookup',
  identity: { serviceName: 'probe', action: 'lookup', method: 'POST' },
  expose: ['CLI'],
  input,
  output: z.unknown(),
  handler: ({ input: args }) => {
    calls++;
    seen = args;
    return args;
  },
};

const surface = {
  name: 'probe',
  globalOptions: appGlobals,
  commands: [inspect],
  runtimeTools: [lookup],
  access: { open: 'local-operator' },
} satisfies Partial<CliConfig>;

interface Answer {
  code: number;
  calls: number;
  seen: unknown;
  stdout: string;
  stderr: string;
}

async function viaCreateCli(argv: string[]): Promise<Answer> {
  calls = 0;
  seen = undefined;
  let stdout = '';
  let stderr = '';
  let code = -1;
  await createCli({
    ...surface,
    version: '1.0.0',
    argv,
    stdin: async () => null,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    exit: (value) => {
      code = value;
    },
  });
  return { code, calls, seen, stdout, stderr };
}

const invoker = await createCliInvoker(surface);
const COMMAND_NAMES = new Set(['inspect', 'lookup']);

const isHelpToken = (token: string): boolean =>
  token === 'help' || token === '--help' || token === '-h';

/** The documented chain an entry point that parses argv itself writes. */
async function viaPublicChain(argv: string[]): Promise<Answer> {
  calls = 0;
  seen = undefined;
  const answer = (code: number, stdout = '', stderr = ''): Answer => ({
    code,
    calls,
    seen,
    stdout,
    stderr,
  });
  try {
    const lifted = extractCliGlobalOptions(argv, appGlobals);
    if (lifted.error !== undefined) return answer(2, '', `${lifted.error.message}\n`);
    const route = routeCliArgv(lifted.argv, { separatedBefore: lifted.separatedBefore });
    if (route.error !== undefined) return answer(2, '', `${route.error}\n`);
    if (route.topLevelHelp || route.command === undefined || isHelpToken(route.command)) {
      const filter = route.helpFilter;
      if (filter !== undefined && ![...COMMAND_NAMES].some((name) => name.includes(filter))) {
        return answer(4, '', `no command matches "${filter}"\n`);
      }
      return answer(0, 'top-level help');
    }
    // A name no command answers to has no schema to read its argv with.
    if (!COMMAND_NAMES.has(route.command)) {
      const unknown = await invoker.invoke(route.command, {});
      return answer(unknown.exitCode, '', `${unknown.error?.message ?? ''}\n`);
    }
    const parsed = parseCliArgs(route.commandArgv, input, {
      separatedBefore: route.separatedBefore,
    });
    if (parsed.options.help) return answer(0, 'command help');
    if (parsed.options.schema) return answer(0, '<schema>');
    if (parsed.options.dryRun) {
      return answer(
        0,
        `${JSON.stringify({ command: route.command, args: parsed.toolArgs }, null, 2)}\n`,
      );
    }
    const result = await invoker.invoke(route.command, parsed.toolArgs);
    if (result.ok) {
      const indent = parsed.options.json ? undefined : 2;
      return answer(result.exitCode, `${JSON.stringify(result.data, null, indent)}\n`);
    }
    return answer(result.exitCode, '', `${result.error?.message ?? ''}\n`);
  } catch (error) {
    if (!(error instanceof CliArgumentError)) throw error;
    return answer(2, '', `${error.message}\n`);
  }
}

/** Help and schema text are not compared byte for byte: the chain does not render them. */
function comparable(answer: Answer): Omit<Answer, 'stderr'> {
  const help = answer.code === 0 && answer.calls === 0 && !answer.stdout.startsWith('{');
  const schema = answer.stdout.startsWith('{"command":') && answer.stdout.includes('"input":');
  return {
    code: answer.code,
    calls: answer.calls,
    seen: answer.seen,
    stdout: schema
      ? '<schema>'
      : help && answer.stdout !== '<schema>'
        ? '<help>'
        : answer.stdout,
  };
}

const COMMAND_LINES: string[][] = [
  // The lines the projections answered differently.
  ['--profile', 'a', '--', 'inspect'],
  ['--', 'inspect'],
  ['--', '--profile', 'x'],
  ['inspect', '--verbose', '--profile', 'demo', 'false'],
  ['--json', 'inspect', '--verbose', '--profile', 'demo', 'false'],
  ['inspect', '--json', '--verbose', '--profile', 'demo', 'false'],
  ['inspect', '--verbose=maybe'],
  ['inspect', '--verbose=banana'],
  ['nosuch'],
  ['--verbose', 'inspect'],
  // A command option where the command name belongs: a usage error, not a command named "--verbose".
  ['--verbose=maybe', 'inspect'],
  ['--verbose=true', 'inspect'],
  ['--count', '5', 'inspect'],
  ['-x', 'inspect'],
  ['--verbose'],
  ['--verbose', '--help'],
  ['--json', 'inspect'],
  ['--profile', 'demo', '--verbose', 'inspect'],
  ['--profile', '--help'],
  ['inspect', '--profile', '--help'],
  ['--compress=maybe', '--help'],
  ['inspect', '--compress=maybe', '--help'],
  ['inspect', '--help', '--json', '--profile', 'demo', 'false'],
  ['inspect', '--schema'],
  ['--json=maybe'],
  ['inspect', '--wait-timeout', '--profile', 'demo', '5'],
  // A flag on both sides of the command, and broken / adjacent boolean boundaries.
  ['--profile', 'demo', 'inspect', '--verbose', 'false'],
  ['inspect', '--verbose', 'false'],
  ['inspect', '--name', '--profile', 'demo', 'x'],
  ['inspect', '--name', 'x', '--profile', 'demo'],
  ['--dry-run', 'inspect', 'false'],
  ['inspect', '--dry-run', '--profile', 'demo', 'false'],
  ['inspect', '--dry-run', 'false'],
  ['inspect', '--dry-run', '--profile', 'demo', '--', 'false'],
  ['inspect', '--json', '--profile', 'demo', 'false'],
  ['--json', '--profile', 'demo', 'inspect', 'false'],
  ['inspect', '--quiet'],
  ['--quiet', 'inspect'],
  ['inspect', '--compress', 'false'],
  ['--compress', 'false', 'inspect'],
  ['--compress', 'inspect', 'false'],
  ['inspect', '--compress', '--verbose', 'false'],
  ['inspect', '--compress=maybe'],
  ['--compress=maybe', 'inspect'],
  ['--help=true'],
  ['--help=false'],
  ['--json'],
  ['--quiet'],
  ['--schema', '--schema=false', 'inspect'],
  ['inspect', '--schema', '--schema=false'],
  ['inspect', '--schema:=true', '--schema'],
  ['inspect', '--count', 'abc'],
  ['inspect', '--count', '5', 'hello'],
  ['inspect', '--profile=a', '--profile=b'],
  ['inspect', '--help', '--profile=a', '--profile=b'],
  ['inspect', '--', '--profile', 'x'],
  ['inspect', 'hello', '--profile', 'demo', 'world'],
  ['inspect', '-h'],
  ['inspect', '--wait-timeout', '--profile', 'x'],
  // Help and `--schema` answer a line whose arguments are wrong, on either side of the error.
  ['inspect', '--verbose=maybe', '--help'],
  ['inspect', '-h', '--verbose=maybe'],
  ['inspect', '-x', '--help'],
  ['inspect', '--help', '-x'],
  ['inspect', '--count', 'abc', '--help'],
  ['inspect', '--name', '--help'],
  ['inspect', '--json', '--json', '--help'],
  ['--json', '--json', 'inspect', '--help'],
  ['inspect', '--nope', '--schema'],
  ['inspect', '--schema', '--count', 'abc'],
  ['inspect', '--quiet', '--quiet', '--schema'],
  ['--schema', 'inspect', '--nope'],
  ['--help', 'inspect', '-x'],
  ['inspect', '--verbose=maybe', '--help=false'],
  ['inspect', '--nope', '--schema=false'],
  // Before the command: a command option beside `--schema` asks for no command.
  ['--verbose', '--schema'],
  ['--json=maybe', '--schema'],
  ['--count', '5', '--schema'],
  ['--verbose', '-h'],
  ['--schema', '--', 'inspect'],
  ['-h', '--', 'inspect'],
  // A framework refusal comes before the name is looked up.
  ['nosuch', '--json', '--json'],
  ['--json', '--json', 'nosuch'],
  // A lifted global between a bare framework boolean and a boolean word, before the command.
  ['--quiet', '--profile', 'demo', 'true', 'inspect'],
  ['--help', '--json', '--profile=a', 'true'],
  ['--help', '--json', '--profile=a', 'insp'],
  // A bare framework boolean, the command, a boolean word, then help or `--schema`: answered.
  ['--json', 'inspect', 'true', '--help'],
  ['--json', 'inspect', 'false', '-h'],
  ['--dry-run', 'inspect', 'false', '--schema'],
  ['--quiet', 'inspect', 'true', '--schema'],
  ['--dry-run', 'nosuch', 'true', '--help'],
  ['--json', 'inspect', 'true', '--help=false'],
  // A bare `--help` or `--schema` parted from a boolean word asks for nothing.
  ['--schema', '--profile', 'demo', 'false'],
  ['--schema', '--profile', 'demo', 'true', 'inspect'],
  ['inspect', '--schema', '--profile', 'demo', 'false'],
];

describe('every public CLI projection answers like createCli', () => {
  for (const command of ['inspect', 'lookup']) {
    for (const written of COMMAND_LINES) {
      const argv = written.map((token) => (token === 'inspect' ? command : token));
      test(`${command}: ${JSON.stringify(argv)}`, async () => {
        const printed = await viaCreateCli(argv);
        const chained = await viaPublicChain(argv);
        expect(comparable(chained)).toEqual(comparable(printed));
        if (printed.code !== 0) {
          const reason = chained.stderr.trim();
          expect(reason.length).toBeGreaterThan(0);
          expect(printed.stderr).toContain(reason);
        }
      });
    }
  }

  test('the table lines answer what createCli answers', async () => {
    const separatorFirst = await viaCreateCli(['--profile', 'a', '--', 'inspect']);
    expect(separatorFirst).toMatchObject({ code: 2, calls: 0 });
    expect(separatorFirst.stderr).toContain('A command is required before "--"');

    const lifted = await viaCreateCli(['inspect', '--verbose', '--profile', 'demo', 'false']);
    expect(lifted).toMatchObject({
      code: 0,
      calls: 1,
      seen: { verbose: true, text: 'false' },
    });

    for (const word of ['maybe', 'banana']) {
      const strict = await viaCreateCli(['inspect', `--verbose=${word}`]);
      expect(strict).toMatchObject({ code: 2, calls: 0 });
      expect(strict.stderr).toContain(
        `--verbose expects a boolean (true/false), got "${word}"`,
      );
    }

    const unknown = await viaCreateCli(['nosuch']);
    expect(unknown).toMatchObject({ code: 4, calls: 0 });
    expect(unknown.stderr).toContain('Unknown command "nosuch"');
    expect((await invoker.invoke('nosuch', {})).exitCode).toBe(4);

    const help = await viaCreateCli(['--profile', '--help']);
    expect(help).toMatchObject({ code: 0, calls: 0, stderr: '' });
    expect(help.stdout).toContain('Usage: probe');

    expect(routeCliArgv(['--json=maybe']).error).toContain('--json');
  });

  test('a command option before the command name is a usage error that says where it goes', async () => {
    for (const argv of [
      ['--verbose', 'inspect'],
      ['--verbose=maybe', 'inspect'],
      ['--profile', 'demo', '--count', '5', 'inspect'],
    ]) {
      const printed = await viaCreateCli(argv);
      expect(printed, JSON.stringify(argv)).toMatchObject({ code: 2, calls: 0 });
      expect(printed.stderr).not.toContain('Unknown command');
      expect(printed.stderr).toContain('put it after the command name');
      const lifted = extractCliGlobalOptions(argv, appGlobals);
      const route = routeCliArgv(lifted.argv, { separatedBefore: lifted.separatedBefore });
      expect(route.command).toBeUndefined();
      expect(printed.stderr).toContain(route.error ?? 'no route error');
    }
    // A framework flag before the command still applies to it.
    expect(await viaCreateCli(['--json', 'inspect'])).toMatchObject({ code: 0, calls: 1 });
    expect(routeCliArgv(['--json', 'inspect'])).toMatchObject({ command: 'inspect' });
    // With a default command, a leading command option is that command's.
    expect(routeCliArgv(['--verbose', 'x'], { defaultCommand: 'inspect' })).toMatchObject({
      command: 'inspect',
    });
  });

  test('an argv lifted before the separator keeps the separator', () => {
    for (const [argv, rest] of [
      [
        ['--', 'inspect'],
        ['--', 'inspect'],
      ],
      [
        ['--profile', 'a', '--', 'inspect'],
        ['--', 'inspect'],
      ],
      [
        ['--', '--profile', 'x'],
        ['--', '--profile', 'x'],
      ],
      [
        ['inspect', '--profile', 'a', '--', '--profile', 'x'],
        ['inspect', '--', '--profile', 'x'],
      ],
    ] as const) {
      expect(extractCliGlobalOptions(argv, appGlobals).argv).toEqual([...rest]);
      expect(extractCliGlobalOptions([...rest], undefined).argv).toEqual([...rest]);
    }
  });

  test('the route carries a lifted boundary into the command argv', () => {
    const lifted = extractCliGlobalOptions(
      ['--json', 'inspect', '--verbose', '--profile', 'demo', 'false'],
      appGlobals,
    );
    expect(lifted.argv).toEqual(['--json', 'inspect', '--verbose', 'false']);
    expect(lifted.separatedBefore).toEqual(new Set([3]));
    const route = routeCliArgv(lifted.argv, { separatedBefore: lifted.separatedBefore });
    expect(route.commandArgv).toEqual(['--json', '--verbose', 'false']);
    expect(route.separatedBefore).toEqual(new Set([2]));
    expect(
      parseCliArgs(route.commandArgv, input, { separatedBefore: route.separatedBefore })
        .toolArgs,
    ).toEqual({ verbose: true, text: 'false' });
    // The single-pass scan reaches the same arguments.
    const scan = scanCliInvocation(
      ['--json', 'inspect', '--verbose', '--profile', 'demo', 'false'],
      { appGlobals },
    );
    expect(
      parseCliArgs(scan.commandTokens, input, { separatedBefore: scan.separatedBefore })
        .toolArgs,
    ).toEqual({ verbose: true, text: 'false' });
    // Nothing separated: the route has no boundary to carry.
    expect('separatedBefore' in routeCliArgv(['inspect', '--verbose', 'false'])).toBe(false);
  });

  test('an entry point that lifts globals to choose its catalogue sees no command before "--"', async () => {
    // The shape of a consuming CLI's `main`: lift the globals, ask the route which command
    // the line names to decide whether to discover the server catalogue, then hand the
    // whole argv to `createCli`.
    const argv = ['--profile', 'a', '--', 'inspect'];
    const { argv: routed, globals } = extractCliGlobalOptions(argv, appGlobals);
    expect(globals).toEqual({ profile: 'a' });
    expect(routed).toEqual(['--', 'inspect']);
    const route = routeCliArgv(routed);
    expect(route.command).toBeUndefined();
    expect(route.error).toBe('A command is required before "--"');
    const printed = await viaCreateCli(argv);
    expect(printed).toMatchObject({ code: 2, calls: 0, stdout: '' });
    expect(printed.stderr).toBe('A command is required before "--"\n');
  });

  test('parseCliArgs answers help and --schema before the arguments it cannot read', () => {
    for (const [argv, asked] of [
      [['--verbose=maybe', '--help'], 'help'],
      [['-h', '--verbose=maybe'], 'help'],
      [['-x', '--help'], 'help'],
      [['--count', 'abc', '--help'], 'help'],
      [['--json', '--json', '--help'], 'help'],
      [['--nope', '--schema'], 'schema'],
      [['--schema', '--count', 'abc'], 'schema'],
    ] as const) {
      const parsed = parseCliArgs([...argv], input);
      expect(parsed.options[asked], JSON.stringify(argv)).toBe(true);
      expect(parsed.toolArgs).toEqual({});
    }
    // A valid line keeps its arguments beside the request, as before.
    expect(parseCliArgs(['--name', 'x', '--help'], input)).toMatchObject({
      toolArgs: { name: 'x' },
      options: { help: true },
    });
    // Without a request the refusal stands; a request switched off is no request.
    for (const argv of [
      ['--verbose=maybe'],
      ['--verbose=maybe', '--help=false'],
      ['-x', '--schema=false'],
      ['--help', 'false', '-x'],
    ]) {
      expect(() => parseCliArgs(argv, input), JSON.stringify(argv)).toThrow(CliArgumentError);
    }
  });

  test('help keeps a broken boundary: the word is not read as the flag value', () => {
    const route = routeCliArgv(['--json', 'inspect', 'false', '--help']);
    expect(route).toMatchObject({
      command: 'inspect',
      commandArgv: ['--json', 'false', '--help'],
      separatedBefore: new Set([1]),
    });
    const parsed = parseCliArgs(route.commandArgv, input, {
      separatedBefore: route.separatedBefore,
    });
    // `createCli` reads the bare `--json` as true and answers help; the chain reads the same.
    expect(parsed.options).toMatchObject({ help: true, json: true });
    expect(
      scanCliInvocation(['--json', 'inspect', 'false', '--help']).framework,
    ).toMatchObject({
      help: true,
      json: true,
    });
  });

  test('a framework boolean separated from a boolean word is refused, not read as either', () => {
    const separated = new Set([1]);
    for (const flag of ['--dry-run', '--json']) {
      expect(() =>
        parseCliArgs([flag, 'false'], input, { separatedBefore: separated }),
      ).toThrow(`${flag}=false`);
      // The route reads framework options too: it refuses the line as `createCli` does.
      const route = routeCliArgv(['inspect', flag, 'false'], {
        separatedBefore: new Set([2]),
      });
      expect(route.command).toBeUndefined();
      expect(route.error).toContain(`${flag}=false`);
      expect(route.error).toContain('-- false');
    }
    // A separated value option does not take the token after the boundary as its value.
    const route = routeCliArgv(['inspect', '--wait-timeout', '5'], {
      separatedBefore: new Set([2]),
    });
    expect(route.error).toBe('--wait-timeout requires a value');
    expect(() =>
      parseCliArgs(['--wait-timeout', '5'], input, { separatedBefore: new Set([1]) }),
    ).toThrow('--wait-timeout requires a value');
    // Adjacent, the word is the value.
    expect(parseCliArgs(['--dry-run', 'false'], input).options.dryRun).toBe(false);
  });

  test('non-throwing error field lets a dynamic-catalog entry point defer invalid argv to createCli (exit 2) without try/catch', async () => {
    for (const argv of [['--json', '--profile', 'prod', 'false'], ['--profile']]) {
      const lifted = extractCliGlobalOptions(argv, appGlobals);
      expect(lifted.error).toBeInstanceOf(CliArgumentError);
      expect(lifted.argv).toEqual([]);

      const scan = scanCliInvocation(argv, { appGlobals });
      expect(scan.error).toBeInstanceOf(CliArgumentError);
      expect(scan.command).toBeUndefined();
      expect(scan.commandTokens).toEqual([]);

      // Consumer checks `if (lifted.error) ...` without catching and skips remote discovery,
      // handing the raw argv to `createCli` which renders the unified exit-2 error.
      let remoteDiscoveryCalls = 0;
      if (!lifted.error) {
        const route = routeCliArgv(lifted.argv, { separatedBefore: lifted.separatedBefore });
        if (!route.error && route.command) remoteDiscoveryCalls += 1;
      }
      expect(remoteDiscoveryCalls).toBe(0);

      const printed = await viaCreateCli(argv);
      expect(printed.code).toBe(2);
      expect(printed.calls).toBe(0);
      expect(printed.stdout).toBe('');
      expect(printed.stderr.trim().length).toBeGreaterThan(0);
    }
  });
});
