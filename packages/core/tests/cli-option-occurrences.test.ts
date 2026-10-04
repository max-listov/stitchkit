import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { extractCliGlobalOptions, parseCliArgs } from '../src/tools/cli/args';
import { routeCliArgv } from '../src/tools/cli/args-route';
import { CliArgumentError } from '../src/tools/cli/argument-error';

const Input = z.strictObject({
  root: z.string(),
  issuer: z.string().optional(),
  check: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  switches: z.array(z.boolean()).optional(),
});
const policy = {
  positionals: ['root'],
  optionAliases: new Map([
    ['c', 'check'],
    ['i', 'issuer'],
    ['t', 'tags'],
  ]),
};
const booleanForms: { argv: string[]; value: boolean }[] = [
  { argv: ['--check'], value: true },
  { argv: ['--check', 'true'], value: true },
  { argv: ['--check', 'false'], value: false },
  { argv: ['--check=true'], value: true },
  { argv: ['--check=false'], value: false },
  { argv: ['--check=yes'], value: true },
  { argv: ['--check=0'], value: false },
  { argv: ['--no-check'], value: false },
  { argv: ['-c'], value: true },
  { argv: ['-c', 'true'], value: true },
  { argv: ['-c', 'false'], value: false },
  { argv: ['-c=true'], value: true },
  { argv: ['-c=false'], value: false },
];

describe('CLI option occurrences before coercion', () => {
  test('every supported boolean spelling is a single value without shifting root', () => {
    for (const { argv, value } of booleanForms) {
      expect(parseCliArgs([...argv, '/workspace'], Input, policy).toolArgs).toEqual({
        root: '/workspace',
        check: value,
      });
    }
    expect(parseCliArgs(['/workspace'], Input, policy).toolArgs).toEqual({
      root: '/workspace',
    });
  });

  test('mixed inline and bare booleans are refused in both orders', () => {
    for (const flags of [
      ['--check=false', '--check'],
      ['--check', '--check=false'],
    ]) {
      expect(() => parseCliArgs(['/workspace', ...flags], Input, policy)).toThrow(
        '--check was passed 2 times',
      );
    }
  });

  test('repeated separate and negative boolean forms are refused', () => {
    for (const flags of [
      ['--check', 'true', '--check', 'false'],
      ['--check', 'false', '--check', 'false'],
      ['--no-check', '--no-check'],
    ]) {
      expect(() => parseCliArgs(['/workspace', ...flags], Input, policy)).toThrow(
        '--check was passed 2 times',
      );
    }
  });

  test('all ordered boolean pairs share one canonical occurrence count', () => {
    for (const first of booleanForms) {
      for (const second of booleanForms) {
        expect(() =>
          parseCliArgs(['/workspace', ...first.argv, ...second.argv], Input, policy),
        ).toThrow('--check was passed 2 times');
      }
    }
  });

  test('scalar aliases refuse duplicates without exposing either value', () => {
    for (const flags of [
      ['--issuer=private-value', '-i', 'other-private-value'],
      ['-i', 'private-value', '--issuer=other-private-value'],
    ]) {
      try {
        parseCliArgs(['/workspace', ...flags], Input, policy);
        throw new Error('duplicate invocation was accepted');
      } catch (error) {
        expect(error).toBeInstanceOf(CliArgumentError);
        expect(error instanceof Error ? error.message : '').toBe(
          '--issuer was passed 2 times',
        );
      }
    }
  });

  test('duplicate admission precedes scalar coercion and includes declared other fields', () => {
    const Scalars = z.object({
      count: z.number(),
      mode: z.enum(['one', 'two']),
      meta: z.object({ key: z.string() }),
      value: z.union([z.string(), z.number()]),
    });
    for (const name of ['count', 'mode', 'meta', 'value']) {
      expect(() => parseCliArgs([`--${name}=invalid`, `--${name}=second`], Scalars)).toThrow(
        `--${name} was passed 2 times`,
      );
    }
    expect(() =>
      parseCliArgs(['--opaque=a', '--opaque=b'], undefined, { knownFields: ['opaque'] }),
    ).toThrow('--opaque was passed 2 times');
  });

  test('arrays accumulate across aliases and unknown passthrough retains raw repeats', () => {
    expect(
      parseCliArgs(
        ['/workspace', '--tags=a', '-t', 'b', '--switches=true', '--switches=false'],
        Input,
        policy,
      ).toolArgs,
    ).toEqual({ root: '/workspace', tags: ['a', 'b'], switches: [true, false] });
    expect(
      parseCliArgs(['--free=a', '--free=b'], Input, {
        ...policy,
        allowUnknown: true,
      }).toolArgs,
    ).toEqual({ free: ['a', 'b'] });
    expect(() =>
      parseCliArgs(['--free.x=a', '--free.x=b'], Input, { allowUnknown: true }),
    ).toThrow('--free.x was passed 2 times');
  });

  test('separator ends occurrence counting and variadic positionals retain literal flags', () => {
    const LiteralInput = Input.extend({ words: z.array(z.string()) });
    expect(
      parseCliArgs(
        ['/workspace', '--check', '--', '--check', '--no-check', '-c'],
        LiteralInput,
        { ...policy, positionals: ['root', 'words'] },
      ).toolArgs,
    ).toEqual({
      root: '/workspace',
      words: ['--check', '--no-check', '-c'],
      check: true,
    });
    expect(parseCliArgs(['--check', '--', 'false'], Input, policy).toolArgs).toEqual({
      root: 'false',
      check: true,
    });
  });

  test('single invalid aliases retain usage errors while long boolean values stay raw', () => {
    expect(() => parseCliArgs(['-c=banana'], Input, policy)).toThrow(CliArgumentError);
    expect(parseCliArgs(['--check=banana'], Input, policy).toolArgs.check).toBe('banana');
    expect(() => parseCliArgs(['--json=banana'], Input, policy)).toThrow(CliArgumentError);
  });

  test('an invalid repeated alias refuses multiplicity without printing its value', () => {
    for (const flags of [
      ['--check=false', '-c=private-second-value'],
      ['-c=false', '-c=private-second-value'],
    ]) {
      expect(() => parseCliArgs(flags, Input, policy)).toThrow('--check was passed 2 times');
    }
  });

  test('declared boolean names with dots remain literal fields beside a nested object', () => {
    const DottedInput = z.strictObject({
      'feature.enabled': z.boolean(),
      feature: z.object({ mode: z.string() }).optional(),
    });
    const dottedPolicy = { optionAliases: new Map([['f', 'feature.enabled']]) };
    for (const flags of [
      ['-f=false'],
      ['--feature.enabled', 'false'],
      ['--no-feature.enabled'],
    ]) {
      expect(
        parseCliArgs([...flags, '--feature={"mode":"inspect"}'], DottedInput, dottedPolicy)
          .toolArgs,
      ).toEqual({ 'feature.enabled': false, feature: '{"mode":"inspect"}' });
    }
    expect(() =>
      parseCliArgs(['-f=false', '--feature.enabled'], DottedInput, dottedPolicy),
    ).toThrow('--feature.enabled was passed 2 times');
  });

  test('absence and explicit false preserve the schema default contract', () => {
    const DefaultInput = z.object({ check: z.boolean().default(true) });
    expect(DefaultInput.parse(parseCliArgs([], DefaultInput).toolArgs)).toEqual({
      check: true,
    });
    expect(
      DefaultInput.parse(parseCliArgs(['--check', 'false'], DefaultInput).toolArgs),
    ).toEqual({ check: false });
  });

  test('canonical inline dotted values retain nested paths beside literal boolean fields', () => {
    const NestedInput = z.strictObject({
      'feature.enabled': z.boolean().optional(),
      feature: z.object({ enabled: z.boolean() }),
    });
    const parsed = parseCliArgs(['--feature.enabled=false'], NestedInput).toolArgs;
    expect(parsed).toEqual({ feature: { enabled: false } });
    expect(NestedInput.parse(parsed)).toEqual({ feature: { enabled: false } });
    expect(() =>
      parseCliArgs(['--feature.enabled=false', '--feature={"enabled":true}'], NestedInput),
    ).toThrow('--feature conflicts with --feature.enabled');
    expect(() =>
      parseCliArgs(['--feature.enabled=false', '--feature.enabled', 'false'], NestedInput),
    ).toThrow('--feature.enabled was passed 2 times');
  });
});

describe('framework and application global occurrences', () => {
  test('every framework option is single-use including the help alias', () => {
    for (const name of ['json', 'wait', 'quiet', 'dry-run', 'help', 'ascending']) {
      expect(() => parseCliArgs([`--${name}=false`, `--${name}`], Input)).toThrow(
        `--${name} was passed 2 times`,
      );
    }
    for (const [name, value] of [
      ['wait-timeout', '2'],
      ['output-dir', '/tmp/result'],
      ['count-by', 'kind'],
      ['sum', 'size'],
      ['by', 'kind'],
      ['top', '2'],
      ['table', 'name'],
      ['sort', 'name'],
    ]) {
      expect(() => parseCliArgs([`--${name}=${value}`, `--${name}=${value}`], Input)).toThrow(
        `--${name} was passed 2 times`,
      );
    }
    for (const flags of [
      ['--help', '-h'],
      ['-h', '--help'],
    ]) {
      expect(() => parseCliArgs(flags, Input)).toThrow('--help was passed 2 times');
    }
  });

  test('leading framework flags count with flags after the explicit command', () => {
    const routed = routeCliArgv(['--json=false', 'run', '--json'], 'run');
    expect(() => parseCliArgs(routed.commandArgv, Input)).toThrow('--json was passed 2 times');
  });

  test('application boolean and string globals refuse all repetitions across the command', () => {
    const Globals = z.object({
      verbose: z.boolean().optional(),
      issuer: z.string().optional(),
    });
    for (const first of [['--verbose'], ['--verbose', 'false'], ['--verbose=true']]) {
      for (const second of [['--verbose'], ['--verbose', 'false'], ['--verbose=true']]) {
        expect(() => extractCliGlobalOptions([...first, 'run', ...second], Globals)).toThrow(
          '--verbose was passed 2 times',
        );
      }
    }
    expect(() =>
      extractCliGlobalOptions(['--issuer=a', 'run', '--issuer', 'b'], Globals),
    ).toThrow('--issuer was passed 2 times');
  });

  test('application arrays, defaults, singles and separator preserve routing', () => {
    const Globals = z.object({
      verbose: z.boolean().default(true),
      scopes: z.array(z.string()).optional(),
    });
    expect(extractCliGlobalOptions(['run'], Globals)).toEqual({
      argv: ['run'],
      globals: { verbose: true },
    });
    expect(
      extractCliGlobalOptions(
        ['--scopes=a', '--verbose', 'false', 'run', '--scopes', 'b', '--', '--verbose'],
        Globals,
      ),
    ).toEqual({
      argv: ['run', '--', '--verbose'],
      globals: { verbose: false, scopes: ['a', 'b'] },
    });
  });
});
