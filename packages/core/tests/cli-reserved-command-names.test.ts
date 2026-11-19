import { expect, test } from 'bun:test';
import { z } from 'zod';
import {
  type CliConfig,
  createCli,
  createCliInvoker,
  defineCliCommand,
} from '../src/entrypoints/cli';
import { defineContract } from '../src/entrypoints/contract';
import { implement } from '../src/entrypoints/server';
import { profileTool } from './fixtures/cli-profile-executable';

const input = z.object({ text: z.string().optional() });

function native(name: string, calls: string[]) {
  return defineCliCommand({
    name,
    description: name,
    input,
    output: input,
    handler: ({ input }) => {
      calls.push(name);
      return input;
    },
  });
}

async function invoke(argv: string[], config: Partial<CliConfig>) {
  let code = -1;
  let err = '';
  let out = '';
  await createCli({
    name: 'fixture',
    version: '1',
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
    ...config,
  });
  return { code, err, out };
}

test('native declarations reject framework option spellings before either handler runs', async () => {
  const calls: string[] = [];
  for (const name of [
    '--quiet',
    '--json=false',
    '--sort',
    '--help=topic',
    '-h',
    '--version',
    '--',
  ]) {
    await expect(
      invoke(['--quiet', 'inspect'], {
        commands: [native('inspect', calls), native(name, calls)],
      }),
    ).rejects.toThrow(`CLI command "${name}" is reserved`);
  }
  expect(calls).toEqual([]);
  expect(
    await invoke(['--custom', 'inspect'], { commands: [native('--custom', calls)] }),
  ).toMatchObject({ code: 0, err: '' });
  expect(calls).toEqual(['--custom']);
});

test('known managed names are checked even before offline native dispatch', async () => {
  const calls: string[] = [];
  const commands = [native('inspect', calls)];
  const tool = { ...profileTool('example'), name: '--quiet' };
  const service = implement(
    defineContract(
      { prefix: 'test', scope: 'public' },
      {
        sample: {
          method: 'GET',
          path: '/',
          desc: 'Sample',
          expose: ['CLI'],
          input,
          output: input,
          tool: { name: '--quiet' },
        },
      },
    ),
    {
      sample: ({ input }) => {
        calls.push('contract');
        return input;
      },
    },
  );
  for (const config of [{ runtimeTools: [tool] }, { services: [service] }]) {
    await expect(
      invoke(['--quiet', 'inspect'], {
        ...config,
        commands,
        resolveAuth: () => {
          calls.push('auth');
        },
      }),
    ).rejects.toThrow('CLI command "--quiet" is reserved');
  }
  expect(calls).toEqual([]);
  const isolated = { ...tool, transports: ['MCP'] as const };
  expect(
    await invoke(['--quiet', 'inspect'], { runtimeTools: [isolated], commands }),
  ).toMatchObject({ code: 0, err: '' });
  expect(calls).toEqual(['inspect']);
});

test('a discovered conflict refuses before managed execution and a rename restores it', async () => {
  const calls: string[] = [];
  const remote = {
    ...profileTool('example'),
    name: 'inspect',
    output: z.object({ profile: z.string(), input }),
    handler: () => {
      calls.push('inspect');
      return { profile: 'example', input: {} };
    },
  };
  let other = '--quiet';
  const config = {
    resolveAuth: () => {
      calls.push('auth');
    },
    runtimeTools: () => {
      calls.push('catalog');
      return [remote, { ...remote, name: other }];
    },
  };
  await expect(invoke(['--quiet', 'inspect'], config)).rejects.toThrow(
    'CLI command "--quiet" is reserved',
  );
  expect(calls.splice(0)).toEqual(['auth', 'catalog']);
  other = 'quiet-mode';
  expect(await invoke(['--quiet', 'inspect'], config)).toMatchObject({ code: 0, err: '' });
  expect(calls).toEqual(['auth', 'catalog', 'inspect']);
});

test('unresolved names cannot silently switch the handler and command-first native calls stay offline', async () => {
  const calls: string[] = [];
  const commands = [native('inspect', calls)];
  const config = {
    commands,
    resolveAuth: () => {
      calls.push('auth');
    },
  };
  for (const factory of [
    {
      runtimeTools: () => {
        calls.push('tools');
        return [{ ...profileTool('example'), name: '--quiet' }];
      },
    },
    {
      services: () => {
        calls.push('services');
        return [];
      },
    },
  ]) {
    const result = await invoke(['--quiet', 'inspect'], { ...config, ...factory });
    expect(result).toMatchObject({ code: 2, out: '' });
    expect(result.err).toContain('fixture inspect');
    expect(calls).toEqual([]);
    const first = await invoke(['inspect', '--quiet'], { ...config, ...factory });
    expect(first).toMatchObject({ code: 0, err: '' });
    expect(calls.splice(0)).toEqual(['inspect']);
    expect(
      await invoke(['--quiet', 'inspect'], {
        ...config,
        ...factory,
        defaultCommand: 'inspect',
      }),
    ).toEqual(first);
    expect(calls.splice(0)).toEqual(['inspect']);
  }
});

test('the command-first migration keeps a bare dry-run apart from a positional false', async () => {
  const calls: string[] = [];
  const config = {
    commands: [native('inspect', calls)],
    runtimeTools: () => {
      calls.push('catalog');
      return [];
    },
  };
  const refused = await invoke(['--dry-run', 'inspect', 'false'], config);
  expect(refused).toMatchObject({ code: 2, out: '' });
  expect(refused.err).toContain('--dry-run=true');
  const preview = await invoke(['inspect', '--dry-run=true', 'false'], config);
  expect(preview).toMatchObject({ code: 0, err: '' });
  expect(JSON.parse(preview.out)).toEqual({ command: 'inspect', args: { text: 'false' } });
  expect(calls).toEqual([]);
  expect(await invoke(['inspect', '--dry-run', 'false'], config)).toMatchObject({
    code: 0,
    err: '',
  });
  expect(calls).toEqual(['inspect']);
});

test('an exact-name in-process invocation has no shell option syntax', async () => {
  const calls: string[] = [];
  const invoker = await createCliInvoker({
    name: 'fixture',
    commands: [native('--quiet', calls)],
  });
  expect((await invoker.invoke('--quiet', { text: 'inspect' })).ok).toBe(true);
  expect(calls).toEqual(['--quiet']);
});
