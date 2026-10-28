import { expect, test } from 'bun:test';
import { z } from 'zod';
import {
  type CliConfig,
  createCli,
  createCliInvoker,
  defineCliCommand,
  type RuntimeToolDefinition,
} from '../src/entrypoints/cli';
import { defineContract, STITCH_ERROR_STATUS } from '../src/entrypoints/contract';
import { implement } from '../src/entrypoints/server';
import { unavailableCommand } from '../src/tools/cli/unavailable';
import { toolErrorFromResult } from '../src/tools/execute-result';

function operation(name: string, input: z.ZodObject): RuntimeToolDefinition {
  return {
    name,
    description: `${name} operation`,
    identity: { serviceName: 'catalog', action: name, method: 'POST' },
    transports: ['CLI'],
    input,
    output: z.unknown(),
    handler: ({ input }) => input,
  };
}
const healthy = operation('healthy', z.object({ text: z.string().default('hello') }));
const blocked = operation('blocked', z.object({ caller: z.string() }));
const reserved = operation('reserved', z.object({ json: z.boolean() }));
const globalOptions = z.object({ caller: z.string().optional() });
const reason =
  '[stitchkit] CLI command "blocked" declares field(s) shadowed by application global options: caller';
const reservedReason =
  '[stitchkit] CLI command "reserved" declares reserved option field(s): json';

async function run(argv: string[], config: Partial<CliConfig> = {}) {
  let out = '';
  let err = '';
  let code = -1;
  await createCli({
    name: 'catalog',
    version: '1',
    globalOptions,
    runtimeTools: [blocked, healthy, reserved],
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
  return { out, err, code };
}

for (const runtimeTools of [
  [blocked, healthy],
  [healthy, blocked],
]) {
  test(`healthy command runs with a conflict ${runtimeTools[0] === blocked ? 'before' : 'after'} it`, async () => {
    const result = await run(['healthy', '--json'], { runtimeTools });
    expect(result).toEqual({ out: '{"text":"hello"}\n', err: '', code: 0 });
  });
}

for (const argv of [
  ['--help'],
  ['--help', 'blocked'],
  ['blocked', '--help'],
  ['blocked', '--help=true'],
  ['blocked', '--help=YES'],
  ['blocked', '--help=1'],
]) {
  test(`${argv.join(' ')} exposes the unavailable command and full reason`, async () => {
    const result = await run(argv);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.out).toContain(`Unavailable: ${reason}`);
    if (argv[0] !== 'blocked') expect(result.out).toContain('[unavailable]');
    if (argv.length === 1) {
      expect(result.out).toContain(`Unavailable: ${reservedReason}`);
      expect(result.out).toContain('healthy');
    }
  });
}

for (const [flags, compact] of [
  [[], false],
  [['--json'], true],
  [['--json=true'], true],
  [['--json=YES'], true],
  [['--json', 'false'], false],
  [['--json=false'], false],
  [['--no-json'], false],
  [['--', '--json'], false],
  [['--help=false'], false],
  [['--', '--help=true'], false],
] satisfies [string[], boolean][]) {
  test(`unavailable refusal keeps its reason and format for ${flags.join(' ') || 'ordinary call'}`, async () => {
    const result = await run(['blocked', ...flags]);
    expect(result.code).toBe(1);
    expect(result.out).toBe('');
    expect(JSON.parse(result.err)).toEqual({
      error: 'CLI_COMMAND_UNAVAILABLE',
      retryable: false,
      details: { message: reason },
    });
    expect(result.err.trim().includes('\n')).toBe(!compact);
  });
}

test('reserved fields are isolated; invocation refuses before parsing, stdin, context and hooks', async () => {
  const calls = { handler: 0, stdin: 0, context: 0, hook: 0 };
  const result = await run(['reserved', '--dry-run', '--unknown', '--json'], {
    runtimeTools: [
      {
        ...reserved,
        handler: () => {
          calls.handler++;
        },
      },
      healthy,
    ],
    stdin: async () => {
      calls.stdin++;
      return 'input';
    },
    context: () => {
      calls.context++;
      return {};
    },
    hooks: {
      beforeToolCall: () => {
        calls.hook++;
      },
    },
  });
  expect(result.code).toBe(1);
  expect(JSON.parse(result.err).details.message).toBe(reservedReason);
  expect(calls).toEqual({ handler: 0, stdin: 0, context: 0, hook: 0 });
  expect((await run(['healthy', '--json'])).code).toBe(0);
});

test('disabled defaults remain known to presentation policies, with exit code/hint overrides', async () => {
  const result = await run(['--json'], {
    defaultCommand: 'blocked',
    optionAliases: { blocked: { c: 'caller' } },
    positionals: { blocked: ['caller'] },
    exitCodes: { CLI_COMMAND_UNAVAILABLE: 23 },
    errorHint: (name, code) => `${name}: ${code}`,
  });
  expect(result.code).toBe(23);
  expect(JSON.parse(result.err)._hint).toBe('blocked: CLI_COMMAND_UNAVAILABLE');
  expect(JSON.parse(result.err).details.message).toBe(reason);
});

test('native and contract-defined field conflicts remain startup errors', async () => {
  const native = defineCliCommand({
    name: 'native',
    description: 'Authored operation',
    input: z.object({ caller: z.string() }),
    handler: () => undefined,
  });
  await expect(run(['healthy'], { commands: [native] })).rejects.toThrow(
    '[stitchkit] CLI command "native" declares field(s) shadowed by application global options: caller',
  );
  const service = implement(
    defineContract(
      { prefix: 'local', scope: 'public' },
      {
        inspect: {
          method: 'POST',
          path: '/',
          desc: 'Authored contract',
          expose: ['CLI'],
          input: z.object({ caller: z.string() }),
          tool: { name: 'authored' },
        },
      },
    ),
    { inspect: () => undefined },
  );
  await expect(run(['healthy'], { services: [service] })).rejects.toThrow(
    '[stitchkit] CLI command "authored" declares field(s) shadowed by application global options: caller',
  );
});

test('field isolation does not hide local policy, identity or duplicate faults', async () => {
  await expect(
    run(['healthy'], {
      optionAliases: { blocked: { c: 'caller' } },
      passthrough: { blocked: 'caller' },
    }),
  ).rejects.toThrow('cannot alias passthrough field "caller"');
  await expect(
    run(['healthy'], {
      optionAliases: { blocked: { c: 'missing' } },
    }),
  ).rejects.toThrow('targets unknown field "missing"');
  await expect(
    run(['healthy'], { runtimeTools: [blocked, blocked, healthy] }),
  ).rejects.toThrow('Duplicate');
  await expect(
    run(['healthy'], { runtimeTools: [{ ...blocked, name: 'help' }, healthy] }),
  ).rejects.toThrow('"help" is reserved');
});

test('native repair and version do not resolve a broken managed catalogue', async () => {
  let factories = 0;
  const config: Partial<CliConfig> = {
    runtimeTools: () => {
      factories++;
      throw new Error('unreachable catalog');
    },
    commands: [
      defineCliCommand({
        name: 'repair',
        description: 'Repair',
        input: z.object({}),
        output: z.string(),
        handler: () => 'repaired',
      }),
    ],
  };
  expect((await run(['repair', '--json'], config)).out).toBe('"repaired"\n');
  expect((await run(['--version'], config)).code).toBe(0);
  expect(factories).toBe(0);
});

test('direct invoker retains reserved/global-named input separately from globals', async () => {
  const both = operation('both', z.object({ caller: z.string(), json: z.boolean() }));
  const invoker = await createCliInvoker(
    { name: 'catalog', globalOptions, runtimeTools: [both, healthy] },
    { caller: 'application' },
  );
  expect(await invoker.invoke('both', { caller: 'operation', json: false })).toEqual({
    ok: true,
    exitCode: 0,
    data: { caller: 'operation', json: false },
  });
  expect((await invoker.invoke('healthy', {})).ok).toBe(true);
});

for (const target of ['blocked', 'unknown', 'healthy']) {
  test(`--wait distinguishes ${target} poll target`, async () => {
    let checks = 0;
    const result = await run(['healthy', '--wait', '--quiet', '--json'], {
      wait: {
        healthy: {
          tool: target,
          poll: () => ({}),
          done: () => target === 'healthy' && ++checks > 1,
          backoff: [0],
          timeout: 1,
        },
      },
    });
    if (target === 'healthy') {
      expect(result.code).toBe(0);
      expect(JSON.parse(result.out)).toEqual({ text: 'hello' });
      return;
    }
    const error = JSON.parse(result.err);
    if (target === 'blocked') {
      expect(error.error).toBe('CLI_COMMAND_UNAVAILABLE');
      expect(error.details.message).toBe(reason);
    } else if (target === 'unknown') {
      expect(error.error).toBe('NOT_FOUND');
      expect(error.details.message).toBe('--wait: no command "unknown" to poll');
    }
  });
}

test('framework refusal retains its registered status across a JSON hop', () => {
  const failure = unavailableCommand(reason);
  expect(STITCH_ERROR_STATUS.CLI_COMMAND_UNAVAILABLE).toBe(409);
  const projected = toolErrorFromResult(JSON.parse(JSON.stringify(failure)));
  expect(projected.status).toBe(409);
  expect(projected.retryable).toBe(false);
  expect(projected.message).toBe(reason);
});
