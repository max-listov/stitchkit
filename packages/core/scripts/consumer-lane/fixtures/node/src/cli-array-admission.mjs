import assert from 'node:assert/strict';
import { createCli, defineCliCommand, parseCliArgs } from 'stitchkit/cli';
import { AppError } from 'stitchkit/contract';
import { defineRuntimeTool } from 'stitchkit/tools';
import { z } from 'zod';

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
let calls = 0;
let reads = 0;
const handler = ({ input }) => {
  calls++;
  return input;
};
const runtime = defineRuntimeTool({
  name: 'resolve',
  description: 'Resolve synthetic references',
  identity: { serviceName: 'fixture', action: 'resolve', method: 'POST' },
  input: Input,
  output: Input,
  transports: ['CLI'],
  handler,
});
const native = defineCliCommand({
  name: 'local',
  description: 'Resolve local references',
  input: Input,
  output: Input,
  handler,
});

async function run(argv, config = {}) {
  let out = '';
  let err = '';
  let code = -1;
  const before = calls;
  const beforeReads = reads;
  await createCli({
    name: 'fixture',
    version: '1',
    commands: [native],
    runtimeTools: () => [runtime],
    ...config,
    argv,
    stdin: async () => {
      reads++;
      return null;
    },
    stdout: (value) => {
      out += value;
    },
    stderr: (value) => {
      err += value;
    },
    exit: (value) => {
      code = value;
    },
  });
  return { out, err, code, calls: calls - before, reads: reads - beforeReads };
}

for (const command of ['resolve', 'local']) {
  const mixed = await run([
    command,
    '--scope',
    'all',
    '--references',
    'alpha.md',
    'beta.md',
    'gamma.md',
  ]);
  assert.equal(mixed.code, 2);
  assert.match(
    mixed.err,
    /--references cannot be combined with automatic positional arguments/,
  );
  assert.equal(mixed.calls, 0);
  assert.equal(mixed.reads, 0);
  for (const flags of [
    ['--references=alpha.md', '--references=beta.md', '--references=gamma.md'],
    ['--references:=["alpha.md","beta.md","gamma.md"]'],
  ]) {
    const result = await run([command, ...flags, '--json']);
    assert.equal(result.code, 0);
    assert.equal(result.calls, 1);
    assert.deepEqual(JSON.parse(result.out), expected);
  }
  const help = await run([command, '--references=alpha.md', 'beta.md', '--help']);
  assert.equal(help.code, 0);
  assert.equal(help.calls, 0);
  assert.equal(help.reads, 0);
  assert.match(help.out, /Repeat --references <value>/);
  const unknown = await run([command, '--references=alpha.md', '--unknown=beta.md']);
  assert.equal(unknown.code, 2);
  assert.equal(unknown.calls, 0);
  assert.match(unknown.err, /Unknown option/);
}
for (const argv of [['--help'], ['resolve', '--help']]) {
  const help = await run(argv);
  assert.equal(help.code, 0);
  assert.match(help.out, /resolve/);
  assert.equal(help.calls, 0);
}
const scalar = await run(['resolve', 'one', '--references=alpha.md', '--json'], {
  positionals: { resolve: ['projectId'] },
});
assert.equal(scalar.code, 0);
assert.deepEqual(JSON.parse(scalar.out), {
  ...expected,
  projectId: 'one',
  references: ['alpha.md'],
});
const variadic = await run(['resolve', 'alpha.md', 'beta.md', 'gamma.md', '--json'], {
  positionals: { resolve: ['references'] },
});
assert.equal(variadic.code, 0);
assert.deepEqual(JSON.parse(variadic.out), expected);
const conflict = await run(['resolve', '--references=alpha.md', 'beta.md'], {
  positionals: { resolve: ['references'] },
});
assert.equal(conflict.code, 2);
assert.equal(conflict.calls, 0);
assert.match(conflict.err, /conflicts with the positional values/);
assert.throws(
  () => parseCliArgs(['--references=alpha.md', '--', 'beta.md'], Input),
  /cannot be combined/,
);
assert.throws(
  () =>
    parseCliArgs(['-r', 'alpha.md', 'beta.md'], Input, {
      optionAliases: new Map([['r', 'references']]),
    }),
  /--references cannot be combined/,
);
assert.throws(
  () =>
    parseCliArgs(
      ['--data.references=alpha.md', 'beta.md'],
      z.object({
        projectId: z.string().optional(),
        data: z.object({ references: z.array(z.string()).optional() }),
      }),
    ),
  /--data.references cannot be combined/,
);

let authCalls = 0;
const unavailable = {
  resolveAuth: () => {
    authCalls++;
    throw new AppError('UNREACHABLE', { message: 'Identity offline' });
  },
  exitCodes: { UNREACHABLE: 69 },
};
assert.equal((await run(['local', '--help'], unavailable)).code, 0);
assert.equal((await run(['local', '--references=alpha.md', '--json'], unavailable)).code, 0);
assert.equal(authCalls, 0);
const offlineHelp = await run(['--help'], unavailable);
assert.equal(offlineHelp.code, 0);
assert.match(
  offlineHelp.out,
  /Managed commands are unavailable: UNREACHABLE: Identity offline/,
);
const offlineCall = await run(['resolve', '--references=alpha.md'], unavailable);
assert.equal(offlineCall.code, 69);
assert.equal(offlineCall.calls, 0);
await assert.rejects(
  run(['--help'], { positionals: { absent: ['references'] } }),
  /targets unavailable command/,
);

console.log('packed CLI array admission: ok');
