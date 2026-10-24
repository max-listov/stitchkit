import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createCli, defineCliCommand, parseCliArgs } from '../src/entrypoints/cli';
import { AppError } from '../src/entrypoints/contract';
import { defineRuntimeTool } from '../src/entrypoints/tools';
import type { CliConfig } from '../src/tools/cli/config';

const Input = z.object({
  scope: z.enum(['all', 'project']).default('all'),
  projectId: z.string().default(''),
  repoKey: z.string().default(''),
  references: z.array(z.string()),
});
const expected = {
  scope: 'all',
  projectId: '',
  repoKey: '',
  references: ['alpha.md', 'beta.md', 'gamma.md'],
};

async function run(argv: string[], config: Partial<CliConfig> = {}) {
  let calls = 0;
  let stdinCalls = 0;
  let out = '';
  let err = '';
  let code = -1;
  const handler = ({ input }: { input: z.infer<typeof Input> }) => {
    calls++;
    return input;
  };
  const resolve = defineRuntimeTool({
    name: 'resolve',
    description: 'Resolve synthetic references',
    identity: { serviceName: 'fixture', action: 'resolve', method: 'POST' },
    input: Input,
    output: Input,
    transports: ['CLI'],
    handler,
  });
  const local = defineCliCommand({
    name: 'local',
    description: 'Resolve local references',
    input: Input,
    output: Input,
    handler,
  });
  await createCli({
    name: 'fixture',
    version: '1',
    runtimeTools: () => [resolve],
    commands: [local],
    ...config,
    argv,
    stdin: async () => {
      stdinCalls++;
      return null;
    },
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
  return { calls, stdinCalls, out, err, code };
}

describe('CLI named arrays and positional admission', () => {
  test('the runtime repro and native path refuse before assigning optional fields', async () => {
    for (const command of ['resolve', 'local']) {
      const result = await run([
        command,
        '--scope',
        'all',
        '--references',
        'alpha.md',
        'beta.md',
        'gamma.md',
      ]);
      expect(result.code).toBe(2);
      expect(result.err).toContain(
        '--references cannot be combined with automatic positional arguments',
      );
      expect(result.err).toContain('Repeat --references');
      expect(result.calls).toBe(0);
      expect(result.stdinCalls).toBe(0);
      expect(result.out).toBe('');
    }
  });

  test('bare tokens cannot change meaning by moving around an array flag', () => {
    for (const argv of [
      ['--references', 'alpha.md', 'beta.md'],
      ['beta.md', '--references', 'alpha.md'],
      ['--references=alpha.md', 'beta.md'],
      ['--references', 'alpha.md', 'beta.md', '--references', 'gamma.md'],
      ['--references:=["alpha.md"]', 'beta.md'],
      ['--references', '["alpha.md"]', 'beta.md'],
      ['--references', 'alpha.md', '--', 'beta.md'],
      ['--references', 'alpha.md', '--', '--help'],
    ]) {
      expect(() => parseCliArgs(argv, Input)).toThrow(
        '--references cannot be combined with automatic positional arguments',
      );
    }
  });

  test('aliases, dotted arrays and wrappers resolve the canonical array field', () => {
    expect(() =>
      parseCliArgs(['-r', 'alpha.md', 'beta.md'], Input, {
        optionAliases: new Map([['r', 'references']]),
      }),
    ).toThrow('--references cannot be combined');
    for (const references of [
      z.array(z.string()).optional(),
      z.array(z.string()).nullable(),
      z.array(z.string()).default([]),
    ]) {
      const schema = z.object({
        project: z.string().optional(),
        data: z.object({ references }),
      });
      expect(() => parseCliArgs(['--data.references=alpha.md', 'beta.md'], schema)).toThrow(
        '--data.references cannot be combined',
      );
    }
  });

  test('repeated flags and whole JSON preserve the full list through the public runtime', async () => {
    for (const flags of [
      ['--references', 'alpha.md', '--references', 'beta.md', '--references', 'gamma.md'],
      ['--references=["alpha.md","beta.md","gamma.md"]'],
      ['--references:=["alpha.md","beta.md","gamma.md"]'],
    ]) {
      const result = await run([
        'resolve',
        '--scope=all',
        '--projectId=',
        '--repoKey=',
        ...flags,
        '--json',
      ]);
      expect(result.code).toBe(0);
      expect(result.calls).toBe(1);
      expect(JSON.parse(result.out)).toEqual(expected);
      expect(result.err).toBe('');
    }
  });

  test('declared scalar positionals and variadic tails have exact destinations', async () => {
    const scalar = await run(['resolve', 'project-one', '--references=alpha.md', '--json'], {
      positionals: { resolve: ['projectId'] },
    });
    expect(scalar.code).toBe(0);
    expect(JSON.parse(scalar.out)).toEqual({
      ...expected,
      projectId: 'project-one',
      references: ['alpha.md'],
    });
    const variadic = await run(['resolve', 'alpha.md', 'beta.md', 'gamma.md', '--json'], {
      positionals: { resolve: ['references'] },
    });
    expect(variadic.code).toBe(0);
    expect(JSON.parse(variadic.out)).toEqual(expected);
    const conflict = await run(['resolve', '--references=alpha.md', 'beta.md'], {
      positionals: { resolve: ['references'] },
    });
    expect(conflict.code).toBe(2);
    expect(conflict.calls).toBe(0);
    expect(conflict.err).toContain('--references conflicts with the positional values');
    expect(
      parseCliArgs(['--', '--references', 'beta.md'], Input, {
        positionals: ['references'],
      }).toolArgs,
    ).toEqual({ references: ['--references', 'beta.md'] });
  });

  test('empty policy, unknown options and scalar flags keep their own admission', async () => {
    const named = await run(['resolve', '--references=alpha.md', '--json'], {
      positionals: { resolve: [] },
    });
    expect(named.code).toBe(0);
    const bare = await run(['resolve', '--references=alpha.md', 'beta.md'], {
      positionals: { resolve: [] },
    });
    expect(bare.err).toContain('Unexpected positional argument "beta.md"');
    expect(bare.calls).toBe(0);
    const unknown = await run(['resolve', '--references=alpha.md', '--unknown=beta.md']);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('Unknown option "--unknown"');
    expect(unknown.calls).toBe(0);
    expect(parseCliArgs(['all', '--projectId=one'], Input).toolArgs).toEqual({
      scope: 'all',
      projectId: 'one',
    });
  });

  test('partial dynamic catalogue works without a policy for an absent command', async () => {
    for (const argv of [['--help'], ['resolve', '--help']]) {
      const result = await run(argv);
      expect(result.code).toBe(0);
      expect(result.out).toContain('resolve');
      expect(result.out).not.toContain('content_resolve');
      expect(result.calls).toBe(0);
    }
    await expect(
      run(['--help'], { positionals: { content_resolve: ['references'] } }),
    ).rejects.toThrow('targets unavailable command "content_resolve"');
  });

  test('application array globals do not become command array flags after extraction', async () => {
    const result = await run(['--labels=one', 'resolve', 'all', '--labels=two', '--json'], {
      globalOptions: z.object({ labels: z.array(z.string()) }),
      runtimeTools: [],
      commands: [
        defineCliCommand({
          name: 'resolve',
          description: 'An independent scalar command',
          input: z.object({ scope: z.string() }),
          output: z.object({ scope: z.string() }),
          handler: ({ input }) => input,
        }),
      ],
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ scope: 'all' });
    expect(result.stdinCalls).toBe(0);
  });

  test('missing auth preserves native paths and explains unavailable managed commands', async () => {
    let authCalls = 0;
    const config = {
      exitCodes: { UNREACHABLE: 69 },
      resolveAuth: () => {
        authCalls++;
        throw new AppError('UNREACHABLE', { message: 'Identity offline' });
      },
    };
    const nativeHelp = await run(['local', '--help'], config);
    expect(nativeHelp.code).toBe(0);
    expect(authCalls).toBe(0);
    const native = await run(['local', '--references=alpha.md', '--json'], config);
    expect(native.code).toBe(0);
    expect(native.calls).toBe(1);
    expect(authCalls).toBe(0);
    const help = await run(['--help'], config);
    expect(help.code).toBe(0);
    expect(help.out).toContain('local');
    expect(help.out).toContain(
      'Managed commands are unavailable: UNREACHABLE: Identity offline',
    );
    const managed = await run(['resolve', '--references=alpha.md', '--json'], config);
    expect(managed.code).toBe(69);
    expect(managed.err).toContain('UNREACHABLE');
    expect(managed.err).not.toContain('Unknown command');
    expect(managed.calls).toBe(0);
  });

  test('help explains one value per array option and keeps diagnostic precedence', async () => {
    for (const command of ['resolve', 'local']) {
      for (const helpFlag of ['--help', '-h']) {
        const result = await run([command, '--references=alpha.md', 'beta.md', helpFlag]);
        expect(result.code).toBe(0);
        expect(result.calls).toBe(0);
        expect(result.stdinCalls).toBe(0);
        expect(result.out).toContain('Repeat --references <value>');
        expect(result.out).toContain('--references:=JSON');
        expect(result.out).not.toContain('<value…>');
      }
    }
  });
});
