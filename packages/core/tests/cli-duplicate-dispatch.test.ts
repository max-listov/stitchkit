import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createCli, defineCliCommand } from '../src/entrypoints/cli';
import { defineContract } from '../src/entrypoints/contract';
import { implement } from '../src/entrypoints/server';
import { defineRuntimeTool } from '../src/tools/runtime-tool';

const Input = z.strictObject({
  root: z.string(),
  issuer: z.string().optional(),
  check: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  words: z.array(z.string()).optional(),
  'no-verbose': z.string().optional(),
  'feature.enabled': z.boolean().optional(),
  feature: z.object({ mode: z.string() }).optional(),
});

async function run(argv: string[], defaultCommand?: string) {
  const calls = { handler: 0, stdin: 0, auth: 0, context: 0, afterToolCall: 0 };
  const native = defineCliCommand({
    name: 'native',
    description: 'Inspect the parsed invocation',
    input: Input,
    output: Input,
    handler: ({ input }) => {
      calls.handler++;
      return input;
    },
  });
  const contract = defineContract(
    { prefix: 'inspection', scope: 'public' },
    {
      inspect: {
        method: 'POST',
        path: '/',
        desc: 'Inspect through the contract',
        expose: ['CLI'],
        input: Input,
        output: Input,
        tool: { name: 'managed' },
      },
    },
  );
  const service = implement(contract, {
    inspect: ({ input }) => {
      calls.handler++;
      return input;
    },
  });
  const runtime = defineRuntimeTool({
    name: 'runtime',
    description: 'Inspect a runtime invocation',
    identity: { serviceName: 'inspection', action: 'runtime', method: 'POST' },
    transports: ['CLI'],
    input: Input,
    output: Input,
    handler: ({ input }) => {
      calls.handler++;
      return input;
    },
  });
  let out = '';
  let err = '';
  let code = -1;
  await createCli({
    name: 'inspection',
    version: '1',
    argv,
    defaultCommand,
    commands: [native],
    services: [service],
    runtimeTools: [runtime],
    positionals: { native: ['root', 'words'], managed: ['root'], runtime: ['root'] },
    optionAliases: {
      native: { c: 'check', i: 'issuer', t: 'tags', f: 'feature.enabled' },
      managed: { c: 'check', i: 'issuer' },
      runtime: { c: 'check', i: 'issuer' },
    },
    globalOptions: z.object({
      verbose: z.boolean().optional(),
      scopes: z.array(z.string()).optional(),
    }),
    resolveAuth: () => {
      calls.auth++;
      return {};
    },
    context: () => {
      calls.context++;
      return {};
    },
    hooks: {
      afterToolCall: () => {
        calls.afterToolCall++;
      },
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
    stdin: async () => {
      calls.stdin++;
      return '/stdin-root';
    },
  });
  return { out, err, code, calls };
}

describe('public CLI duplicate refusal precedes dispatch', () => {
  for (const command of ['native', 'managed', 'runtime']) {
    test(`${command} refuses ambiguous booleans before stdin, hooks or handler`, async () => {
      for (const flags of [
        ['--check=false', '--check'],
        ['--check', 'true', '--check', 'false'],
        ['--no-check', '--no-check'],
        ['-c=false', '--check'],
        ['--check', '-c=false'],
        ['--check=false', '-c=private-second-value'],
        ['-c=false', '-c=private-second-value'],
      ]) {
        const result = await run([command, ...flags]);
        expect(result.code).toBe(2);
        expect(result.out).toBe('');
        expect(result.err).toBe('--check was passed 2 times\n');
        expect(result.calls).toMatchObject({ handler: 0, stdin: 0, afterToolCall: 0 });
      }
    });

    test(`${command} executes one unambiguous false invocation once`, async () => {
      const result = await run([command, '/workspace', '--check', 'false', '--json']);
      expect(result.code).toBe(0);
      expect(result.err).toBe('');
      expect(JSON.parse(result.out)).toEqual({ root: '/workspace', check: false });
      expect(result.calls.handler).toBe(1);
      expect(result.calls.stdin).toBe(0);
    });

    test(`${command} help keeps diagnostic precedence over operation argument errors`, async () => {
      const result = await run([command, '--check=false', '--check', '--help', '-h']);
      expect(result.code).toBe(0);
      expect(result.err).toBe('');
      expect(result.out).toContain('--check');
      expect(result.calls).toMatchObject({ handler: 0, stdin: 0, afterToolCall: 0 });
    });
  }

  test('duplicate diagnostics contain only the canonical name and count', async () => {
    const result = await run([
      'native',
      '/unrelated-private-value',
      '--issuer=first-private-value',
      '-i',
      'second-private-value',
    ]);
    expect(result.code).toBe(2);
    expect(result.out).toBe('');
    expect(result.err).toBe('--issuer was passed 2 times\n');
    expect(result.calls.handler).toBe(0);
  });

  test('application global repetition refuses before auth even when help is requested', async () => {
    for (const argv of [
      ['--verbose=false', 'managed', '--verbose'],
      ['managed', '--verbose', '--verbose=false'],
      ['--verbose=false', 'native', '--help', '--verbose'],
    ]) {
      const result = await run(argv);
      expect(result.code).toBe(2);
      expect(result.out).toBe('');
      expect(result.err).toBe('--verbose was passed 2 times\n');
      expect(result.calls).toEqual({
        handler: 0,
        stdin: 0,
        auth: 0,
        context: 0,
        afterToolCall: 0,
      });
    }
  });

  test('leading framework globals and default-command options share the refusal', async () => {
    for (const command of ['native', 'managed']) {
      for (const argv of [
        ['--json=false', command, '--json'],
        ['--check=false', '--check'],
      ]) {
        const result = await run(argv, command);
        expect(result.code).toBe(2);
        expect(result.out).toBe('');
        expect(result.err).toMatch(/^--(?:json|check) was passed 2 times\n$/);
        expect(result.calls).toMatchObject({ handler: 0, stdin: 0, afterToolCall: 0 });
      }
    }
  });

  test('arrays and literal flags after the separator remain valid native inputs', async () => {
    const result = await run([
      '--scopes=a',
      'native',
      '/workspace',
      '--scopes=b',
      '--tags=a',
      '-t',
      'b',
      '--check',
      '--json',
      '--',
      '--check',
      '--no-check',
      '-h',
    ]);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(JSON.parse(result.out)).toEqual({
      root: '/workspace',
      tags: ['a', 'b'],
      check: true,
      words: ['--check', '--no-check', '-h'],
    });
    expect(result.calls.handler).toBe(1);
  });

  test('an application global does not acquire a new negative spelling', async () => {
    const result = await run(['native', '/workspace', '--no-verbose=value', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ root: '/workspace', 'no-verbose': 'value' });
    expect(result.calls.handler).toBe(1);
  });

  test('a boolean alias names the literal dotted schema field', async () => {
    const result = await run([
      'native',
      '/workspace',
      '-f=false',
      '--feature={"mode":"inspect"}',
      '--json',
    ]);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(JSON.parse(result.out)).toEqual({
      root: '/workspace',
      'feature.enabled': false,
      feature: { mode: 'inspect' },
    });
    expect(result.calls.handler).toBe(1);
  });
});
