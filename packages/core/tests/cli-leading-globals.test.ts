import { expect, test } from 'bun:test';
import { z } from 'zod';
import {
  type CliConfig,
  createCli,
  defineCliCommand,
  routeCliArgv,
} from '../src/entrypoints/cli';
import { unauthorized } from '../src/entrypoints/contract';
import { profileTool } from './fixtures/cli-profile-executable';

const input = z.object({ text: z.string().optional() });

async function run(
  argv: string[],
  config: Pick<
    CliConfig,
    'defaultCommand' | 'resolveAuth' | 'globalOptions' | 'runtimeTools'
  > = {},
) {
  let calls = 0;
  let out = '';
  let err = '';
  let code = -1;
  const inspect = defineCliCommand({
    name: 'inspect',
    description: 'Inspect the argument',
    input,
    output: input,
    handler: ({ input }) => {
      calls++;
      return input;
    },
  });
  await createCli({
    ...config,
    name: 'fixture',
    version: '1',
    commands: [inspect, { ...inspect, name: 'fallback', description: 'Default command' }],
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
  return { calls, out, err, code };
}

test('the public route retains option values, the explicit command and its arguments', () => {
  for (const flags of [
    ['--quiet'],
    ['--json', 'false', '--quiet=true'],
    ['--sort', 'version', '--top=2'],
    ['--output-dir', '-cache'],
  ]) {
    expect(routeCliArgv([...flags, 'inspect', '--', '--quiet'])).toEqual({
      command: 'inspect',
      commandArgv: [...flags, '--', '--quiet'],
      topLevelHelp: false,
      version: false,
    });
  }
  for (const version of ['version', '--version']) {
    expect(routeCliArgv([version])).toEqual({
      command: version,
      commandArgv: [],
      topLevelHelp: false,
      version: false,
    });
    expect(routeCliArgv(['--quiet', version]).command).toBe(version);
  }
  const helpRoute = {
    command: 'help',
    commandArgv: ['insp'],
    topLevelHelp: false,
    version: false,
  };
  expect(routeCliArgv(['help', 'insp'])).toEqual({ ...helpRoute, helpFilter: 'insp' });
  expect(routeCliArgv(['help', 'insp'], 'fallback')).toEqual(helpRoute);
});

test('native dispatch respects flag values, command boundaries and duplicate options', async () => {
  for (const word of ['true', 'false']) {
    const expected = {
      calls: 1,
      code: 0,
      err: '',
      out: `${JSON.stringify({ text: word })}\n`,
    };
    expect(await run(['--json', 'inspect', word])).toEqual(expected);
    expect(await run(['inspect', word, '--json'])).toEqual(expected);
  }
  expect(await run(['--quiet', 'inspect', '--json', '--', '--quiet'])).toEqual({
    calls: 1,
    code: 0,
    err: '',
    out: '{"text":"--quiet"}\n',
  });
  const duplicate = await run(['--json=false', 'inspect', '--json']);
  expect(duplicate).toMatchObject({ calls: 0, code: 2, out: '' });
  expect(duplicate.err).toContain('--json was passed 2 times');
  const unknown = await run(['--quiet', 'typo']);
  expect(unknown).toMatchObject({ calls: 0, code: 1, out: '' });
  expect(unknown.err).toContain('Unknown command "typo"');
  for (const argv of [
    ['--quiet', '--', 'inspect'],
    ['--sort', '--', 'inspect'],
  ]) {
    const result = await run(argv);
    expect(result.calls).toBe(0);
    expect(result.code).toBeGreaterThan(0);
  }
});

test('top-level and command help keep their scope after leading globals', async () => {
  const filtered = await run(['--help', 'insp']);
  expect(filtered).toMatchObject({ calls: 0, code: 0, err: '' });
  expect(filtered.out).toContain('Commands matching "insp"');
  for (const spelling of [['help', 'insp'], ['-h', 'insp'], ['--help=insp']]) {
    expect(await run(['--quiet', ...spelling])).toEqual(filtered);
  }
  expect(await run(['--quiet', 'inspect', '--unknown', '--help'])).toEqual(
    await run(['inspect', '--help']),
  );
  expect(await run(['--quiet', '--version'])).toEqual({
    calls: 0,
    code: 0,
    out: 'fixture 1\n',
    err: '',
  });
});

test('a default CLI still answers top-level help and version after a malformed value', async () => {
  const config = { defaultCommand: 'fallback' };
  const filtered = await run(['help', 'insp'], config);
  expect(filtered.out).toContain('Commands matching "insp"');
  expect(await run(['--quiet', 'help', 'insp'], config)).toEqual(filtered);
  for (const request of ['--help', '--version']) {
    const expected = await run([request], config);
    expect(expected).toMatchObject({ calls: 0, code: 0, err: '' });
    expect(await run(['--output-dir', '--oops', request], config)).toEqual(expected);
  }
  const commandHelp = await run(['inspect', '--help'], config);
  expect(commandHelp.out).toContain('Usage: fixture inspect');
  expect(await run(['--sort', '-f', 'inspect', '--help'], config)).toEqual(commandHelp);
  // A separator in the value slot still blocks a later version or command.
  const separated = await run(['--sort', '--', '--version'], config);
  expect(separated).toMatchObject({ code: 2, calls: 0, out: '' });
});

test('a refused managed surface honours the routed JSON flag in either position', async () => {
  const config = { resolveAuth: () => unauthorized('fixture key rejected') };
  const compact = await run(['remote', 'false', '--json'], config);
  expect(compact).toMatchObject({ calls: 0, code: 2, out: '' });
  expect(compact.err.trim().split('\n')).toHaveLength(1);
  expect(JSON.parse(compact.err).error).toBe('UNAUTHORIZED');
  expect(await run(['--json', 'remote', 'false'], config)).toEqual(compact);

  const human = await run(['remote'], config);
  expect(human.err.trim().split('\n').length).toBeGreaterThan(1);
  expect(await run(['--json', 'false', 'remote'], config)).toEqual(human);
  expect(await run(['remote', '--', '--json'], config)).toEqual(human);
});

test('dry-run cannot take a positional boolean across a command or an application option', async () => {
  const globalOptions = z.object({
    profile: z.string().optional(),
    verbose: z.boolean().optional(),
  });
  for (const defaultCommand of [undefined, 'fallback']) {
    const config = { defaultCommand, globalOptions };
    for (const word of ['true', 'false']) {
      const preview = await run(['inspect', word, '--dry-run'], config);
      expect(preview).toMatchObject({ calls: 0, code: 0, err: '' });
      expect(JSON.parse(preview.out)).toEqual({ command: 'inspect', args: { text: word } });
      for (const argv of [
        ['--dry-run', 'inspect', word],
        ['inspect', '--dry-run', '--profile', 'fixture', word],
        ['--dry-run', '--profile=fixture', 'inspect', word],
        ['inspect', '--dry-run', '--profile=fixture', '--verbose=false', word],
      ]) {
        expect(await run(argv, config)).toEqual(preview);
      }
    }
    expect(await run(['inspect', '--dry-run', 'false'], config)).toMatchObject({
      calls: 1,
      code: 0,
      err: '',
    });
  }
});

test('separate false disables schema and command help before dispatch', async () => {
  const actual = await run(['inspect']);
  expect(actual).toMatchObject({ calls: 1, code: 0, err: '' });
  for (const argv of [
    ['--schema', 'false', 'inspect'],
    ['inspect', '--schema', 'false'],
    ['inspect', '--help', 'false'],
    ['inspect', '--help=false'],
  ]) {
    expect(await run(argv)).toEqual(actual);
    const refused = await run([...argv, '--unknown']);
    expect(refused).toMatchObject({ calls: 0, code: 2, out: '' });
    expect(refused.err).toContain('Unknown option "--unknown"');
  }
  const help = await run(['inspect', '--help']);
  expect(help).toMatchObject({ calls: 0, code: 0, err: '' });
  expect(await run(['inspect', '--help', 'false', '-h'])).toEqual(help);
  expect(await run(['inspect', '--help=false', '--help'])).toEqual(help);
  const top = await run(['--help', 'false']);
  expect(top.err).toContain('no command matches "false"');
  const config = { globalOptions: z.object({ profile: z.string().optional() }) };
  expect(await run(['--help', '--profile=fixture', 'false'], config)).toEqual(top);
  expect(await run(['inspect', '--help', '--profile=fixture', 'false'], config)).toEqual(
    await run(['inspect', '--help'], config),
  );
});

test('only enabled schema and help requests skip identity for a static managed command', async () => {
  let attempts = 0;
  const config = {
    runtimeTools: [profileTool('example')],
    resolveAuth: () => {
      attempts++;
      return unauthorized('fixture key rejected');
    },
  };
  for (const flag of ['--schema', '--help']) {
    const presentation = await run(['endpoint', flag, 'true'], config);
    expect(presentation).toMatchObject({ code: 0, err: '' });
    expect(presentation.out).toContain('endpoint');
    expect(attempts).toBe(0);
  }
  for (const argv of [
    ['--schema', 'false', 'endpoint'],
    ['endpoint', '--schema', 'false'],
    ['endpoint', '--help', 'false'],
  ]) {
    const before = attempts;
    const refusal = await run([...argv, '--json'], config);
    expect(refusal).toMatchObject({ code: 2, out: '' });
    expect(JSON.parse(refusal.err).error).toBe('UNAUTHORIZED');
    expect(attempts).toBe(before + 1);
  }
});

test('a malformed leading value option retains its diagnostic and command help', async () => {
  const invalid = await run(['inspect', '--sort', '--oops']);
  expect(invalid).toMatchObject({ calls: 0, code: 2, out: '' });
  expect(invalid.err).toContain('--sort requires a value');
  expect(await run(['--sort', '--oops', 'inspect'])).toEqual(invalid);
  expect(await run(['--sort', '--oops', 'inspect', '--help'])).toEqual(
    await run(['inspect', '--help']),
  );
});
