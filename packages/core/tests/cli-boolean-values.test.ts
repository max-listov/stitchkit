import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  CliArgumentError,
  createCli,
  createCliProfileStore,
  defineCliCommand,
  extractCliGlobalOptions,
  parseCliArgs,
  routeCliArgv,
  scanCliInvocation,
} from '../src/entrypoints/cli';

/*
 * `--flag true` and `--flag false` are an ordinary habit. Read as "the flag,
 * plus a positional", the word slid into the first non-boolean field — and
 * `--flag false` turned the flag ON. After a bare boolean flag, the next token
 * is its value when it is exactly `true` or `false`; anything else stays a
 * positional, as before.
 */

const schema = z.object({
  botId: z.string().optional(),
  visibility: z.enum(['A', 'B']).optional(),
  includeEmbedded: z.boolean().optional(),
});

describe('a boolean flag followed by true or false', () => {
  test('the word is the flag value, and positionals do not shift', () => {
    expect(parseCliArgs(['bot1', '--includeEmbedded', 'true'], schema).toolArgs).toEqual({
      botId: 'bot1',
      includeEmbedded: true,
    });
    expect(parseCliArgs(['bot1', '--includeEmbedded', 'false'], schema).toolArgs).toEqual({
      botId: 'bot1',
      includeEmbedded: false,
    });
    expect(parseCliArgs(['--includeEmbedded', 'false', 'bot1', 'A'], schema).toolArgs).toEqual(
      {
        botId: 'bot1',
        visibility: 'A',
        includeEmbedded: false,
      },
    );
  });

  test('the bare, inline and negated forms mean what they meant', () => {
    expect(parseCliArgs(['--includeEmbedded'], schema).toolArgs).toEqual({
      includeEmbedded: true,
    });
    expect(parseCliArgs(['--includeEmbedded=false'], schema).toolArgs).toEqual({
      includeEmbedded: false,
    });
    expect(parseCliArgs(['--no-includeEmbedded'], schema).toolArgs).toEqual({
      includeEmbedded: false,
    });
  });

  test('any other word after the flag stays a positional, as before', () => {
    expect(parseCliArgs(['--includeEmbedded', 'bot1'], schema).toolArgs).toEqual({
      botId: 'bot1',
      includeEmbedded: true,
    });
    // `1`, `yes` and `no` are values of other fields as often as not; they are not taken.
    expect(parseCliArgs(['--includeEmbedded', 'no'], schema).toolArgs).toEqual({
      botId: 'no',
      includeEmbedded: true,
    });
    // `--` still makes a literal `false` a positional.
    expect(parseCliArgs(['--includeEmbedded', '--', 'false'], schema).toolArgs).toEqual({
      botId: 'false',
      includeEmbedded: true,
    });
  });

  test('the same for a short alias, a framework flag and an application option', () => {
    const aliases = new Map([['e', 'includeEmbedded']]);
    expect(parseCliArgs(['-e', 'false', 'bot1'], schema, { aliases }).toolArgs).toEqual({
      botId: 'bot1',
      includeEmbedded: false,
    });
    const parsed = parseCliArgs(['--json', 'false', '--dry-run', 'true', 'bot1'], schema);
    expect(parsed.options).toMatchObject({ json: false, dryRun: true });
    expect(parsed.toolArgs).toEqual({ botId: 'bot1' });
    const globals = extractCliGlobalOptions(
      ['--verbose', 'false', 'list'],
      z.object({ verbose: z.boolean().optional() }),
    );
    expect(globals).toEqual({ argv: ['list'], globals: { verbose: false } });
  });

  test('before the command, the word is the flag value, not the command name', () => {
    const route = routeCliArgv(['--json', 'false', 'list', 'x'], { defaultCommand: 'run' });
    expect(route.command).toBe('list');
    expect(route.commandArgv).toEqual(['--json', 'false', 'x']);
  });
});

describe('boolean word policy, broken boundaries and passthrough coercion', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const globals = z.object({ profile: z.string().optional() });
  const inspectInput = z.object({ text: z.string().optional() });

  async function runInspect(argv: string[], extra?: { passthrough?: string }) {
    let calls = 0;
    let out = '';
    let err = '';
    let code = -1;
    let seenInput: unknown;
    const inspect = defineCliCommand({
      name: 'inspect',
      description: 'Inspect arguments',
      input: extra?.passthrough
        ? z.object({
            text: z.string().optional(),
            params: z.record(z.string(), z.unknown()).optional(),
          })
        : inspectInput,
      output: z.unknown(),
      handler: ({ input }) => {
        calls++;
        seenInput = input;
        return input;
      },
    });
    await createCli({
      name: 'bool-fixture',
      version: '1.0.0',
      globalOptions: globals,
      commands: [inspect],
      ...(extra?.passthrough && {
        commandSettings: { inspect: { passthrough: extra.passthrough } },
      }),
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
    });
    return { calls, out, err, code, seenInput };
  }

  test('broken boolean boundary across command or application option refuses with hint and zero calls', async () => {
    for (const argv of [
      ['--dry-run', 'inspect', 'false'],
      ['inspect', '--dry-run', '--profile', 'demo', 'false'],
    ]) {
      const result = await runInspect(argv);
      expect(result.code).toBe(2);
      expect(result.calls).toBe(0);
      expect(result.out).toBe('');
      expect(result.err).toContain('--dry-run=false');
      expect(result.err).toContain('-- false');
    }
    // Adjacent --dry-run false remains the flag value and runs the handler once.
    const adjacent = await runInspect(['inspect', '--dry-run', 'false']);
    expect(adjacent.code).toBe(0);
    expect(adjacent.calls).toBe(1);
    expect(adjacent.err).toBe('');
  });

  test('lifting a global keeps the globals readable and refuses the argv it cannot write', async () => {
    // The line stays valid input for the globals: an entry point that reads only them and
    // hands the whole argv to createCli still gets exit 2 with the hint.
    for (const argv of [
      ['inspect', '--dry-run', '--profile', 'demo', 'false'],
      ['inspect', '--help', '--profile', 'demo', 'true'],
    ]) {
      const flag = argv[1];
      const word = argv.at(-1);
      const extracted = extractCliGlobalOptions(argv, globals);
      expect(extracted.globals).toEqual({ profile: 'demo' });
      // ...but `['inspect', '--dry-run', 'false']` would say the opposite of the line, so
      // `error` carries the refusal and `argv` is empty (never throwing on property read).
      expect(extracted.argv).toEqual([]);
      expect(extracted.error).toBeInstanceOf(CliArgumentError);
      expect(extracted.error?.message).toContain(`${flag}=true`);
      expect(extracted.error?.message).toContain(`-- ${word}`);
      const result = await runInspect(argv);
      expect(result.code).toBe(2);
      expect(result.calls).toBe(0);
      expect(result.out).toBe('');
      expect(result.err).toContain(`${flag}=true`);
      expect(result.err).toContain(`-- ${word}`);
    }
  });

  test('a bare command option separated from a boolean word by a lifted global preserves the boundary explicitly', () => {
    const extracted = extractCliGlobalOptions(
      ['inspect', '--verbose', '--profile', 'demo', 'false'],
      globals,
    );
    expect(extracted.globals).toEqual({ profile: 'demo' });
    expect(extracted.argv).toEqual(['inspect', '--verbose', 'false']);
    expect(extracted.separatedBefore).toEqual(new Set([2]));

    const shortExtracted = extractCliGlobalOptions(
      ['inspect', '-v', '--profile', 'demo', 'false'],
      globals,
    );
    expect(shortExtracted.globals).toEqual({ profile: 'demo' });
    expect(shortExtracted.argv).toEqual(['inspect', '-v', 'false']);
    expect(shortExtracted.separatedBefore).toEqual(new Set([2]));
  });

  test('a lifted global that separates nothing leaves the argv as written', () => {
    for (const [argv, rest] of [
      [
        ['--dry-run', 'inspect', 'false'],
        ['--dry-run', 'inspect', 'false'],
      ],
      [
        ['inspect', '--dry-run', 'false', '--profile', 'demo'],
        ['inspect', '--dry-run', 'false'],
      ],
      [
        ['inspect', '--dry-run=true', '--profile', 'demo', 'false'],
        ['inspect', '--dry-run=true', 'false'],
      ],
      [
        ['inspect', '--name', 'x', '--profile', 'demo', 'false'],
        ['inspect', '--name', 'x', 'false'],
      ],
      [
        ['inspect', '--dry-run', '--profile', 'demo', '--', 'false'],
        ['inspect', '--dry-run', '--', 'false'],
      ],
    ] as const) {
      expect(extractCliGlobalOptions(argv, globals).argv).toEqual([...rest]);
    }
  });

  test('routing a bare boolean away from its word reports the refusal instead of an argv', async () => {
    // `['--dry-run', 'false']` is what removing the command would leave: a preview turned
    // into a real call. The route carries the refusal where it already carries one.
    for (const defaultCommand of [undefined, 'help']) {
      const route = routeCliArgv(['--dry-run', 'inspect', 'false'], { defaultCommand });
      expect(route.commandArgv).toEqual([]);
      expect(route.error).toContain('--dry-run=true');
      expect(route.error).toContain('-- false');
    }
    // The adjacent form is a value, and routes as before.
    const adjacent = routeCliArgv(['inspect', '--dry-run', 'false']);
    expect(adjacent.error).toBeUndefined();
    expect(parseCliArgs(adjacent.commandArgv, z.object({})).options.dryRun).toBe(false);
    const explicit = routeCliArgv(['--dry-run=true', 'inspect', 'false']);
    expect(explicit.error).toBeUndefined();
    expect(explicit.commandArgv).toEqual(['--dry-run=true', 'false']);
  });

  test('a line with nothing before the separator names no command', () => {
    expect(routeCliArgv(['--', 'inspect']).error).toBe('A command is required before "--"');
    expect(routeCliArgv(['--', 'inspect']).command).toBeUndefined();
    const scan = scanCliInvocation(['--', 'inspect']);
    expect(scan.command).toBeUndefined();
    expect(scan.commandTokens).toEqual([]);
    expect(scan.error).toBeInstanceOf(CliArgumentError);
    expect(scan.error?.message).toBe('A command is required before "--"');
  });

  test('explicit inline or separator disambiguates the broken boundary', async () => {
    for (const argv of [
      ['--dry-run=true', 'inspect', 'false'],
      ['--dry-run', 'inspect', '--', 'false'],
      ['inspect', '--dry-run=true', '--profile', 'demo', 'false'],
      ['inspect', '--dry-run', '--profile', 'demo', '--', 'false'],
    ]) {
      const result = await runInspect(argv);
      expect(result.code).toBe(0);
      expect(result.calls).toBe(0);
      expect(JSON.parse(result.out)).toEqual({ command: 'inspect', args: { text: 'false' } });
    }
  });

  test('case-insensitive boolean words keep one route and one value', () => {
    const route = routeCliArgv(['--quiet', 'TRUE', 'cmd']);
    expect(route.command).toBe('cmd');
    expect(parseCliArgs(['--quiet', 'TRUE'], inspectInput).options.quiet).toBe(true);
    expect(parseCliArgs(['--quiet', 'FALSE'], inspectInput).options.quiet).toBe(false);
    expect(parseCliArgs(['--includeEmbedded', 'TRUE'], schema).toolArgs).toEqual({
      includeEmbedded: true,
    });
    expect(parseCliArgs(['--includeEmbedded', 'FALSE'], schema).toolArgs).toEqual({
      includeEmbedded: false,
    });
  });

  test('--quiet=maybe refuses with code 2 before any profile notice is emitted', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'stitchkit-bool-profile-'));
    directories.push(directory);
    const store = createCliProfileStore({
      directory,
      schema: z.object({ url: z.url(), token: z.string().min(1) }),
    });
    store.write('prod', { url: 'https://prod.example.test', token: 'fixture-key' });
    let resolveCalls = 0;
    let err = '';
    let code = -1;
    await createCli({
      access: { open: 'local-operator' },
      name: 'profile-bool',
      version: '1.0.0',
      globalOptions: globals,
      resolveAuth: ({ profile }) => {
        resolveCalls++;
        return store.resolve(profile).name;
      },
      runtimeTools: () => [],
      argv: ['--quiet=maybe', 'inspect'],
      stdin: async () => null,
      stdout: () => undefined,
      stderr: (text) => {
        err += text;
      },
      exit: (value) => {
        code = value;
      },
    });
    expect(code).toBe(2);
    expect(resolveCalls).toBe(0);
    expect(err).toContain('--quiet expects a boolean');
    expect(err).not.toContain('using the only configured profile');
  });

  test('passthrough keeps --mode on as string while coercing true/false and numbers', async () => {
    const result = await runInspect(
      ['inspect', '--mode', 'on', '--enabled', 'true', '--count', '3', '--json'],
      { passthrough: 'params' },
    );
    expect(result.code).toBe(0);
    expect(result.calls).toBe(1);
    expect(result.seenInput).toEqual({
      params: { mode: 'on', enabled: true, count: 3 },
    });
  });

  test('stripping a framework or application flag never glues surrounding command tokens', async () => {
    const richInput = z.object({
      text: z.string().optional(),
      verbose: z.boolean().optional(),
    });
    const runRich = async (argv: string[]) => {
      let calls = 0;
      let out = '';
      let err = '';
      let code = -1;
      let seenInput: unknown;
      const cmd = defineCliCommand({
        name: 'inspect',
        description: 'Inspect',
        input: richInput,
        output: z.unknown(),
        handler: ({ input }) => {
          calls++;
          seenInput = input;
          return input;
        },
      });
      await createCli({
        name: 'sep-fixture',
        version: '1.0.0',
        globalOptions: globals,
        commandSettings: { inspect: { aliases: { f: 'verbose' } } },
        commands: [cmd],
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
      });
      return { calls, out, err, code, seenInput };
    };

    for (const argv of [
      ['inspect', '--verbose', '--json=true', 'false'],
      ['inspect', '-f', '--json=true', 'false'],
      ['inspect', '--verbose', '--profile', 'prod', 'false'],
    ]) {
      const res = await runRich(argv);
      expect(res.code).toBe(0);
      expect(res.calls).toBe(1);
      expect(res.seenInput).toEqual({ verbose: true, text: 'false' });
    }

    const missingVal = await runRich(['inspect', '--text', '--json', 'hello']);
    expect(missingVal.code).toBe(2);
    expect(missingVal.calls).toBe(0);
    expect(missingVal.out).toBe('');
    expect(missingVal.err).toContain('--text requires a value');
  });
});
