import assert from 'node:assert/strict';
import { createCli, createCliInvoker, defineCliCommand } from 'stitchkit/cli';
import { z } from 'zod';

const calls = { healthy: 0, blocked: 0, stdin: 0, context: 0, hook: 0 };
const globalOptions = z.object({ caller: z.string().optional() });
const operation = (name, input) => ({
  name,
  description: `${name} operation`,
  identity: { serviceName: 'catalog', action: name, method: 'POST' },
  transports: ['CLI'],
  input,
  output: z.unknown(),
  handler: ({ input }) => {
    calls[name]++;
    return input;
  },
});
const healthy = operation('healthy', z.object({ text: z.string().default('hello') }));
const blocked = operation(
  'blocked',
  z.object({ caller: z.string(), json: z.boolean().optional() }),
);
const globalReason =
  '[stitchkit] CLI command "blocked" declares field(s) shadowed by application global options: caller';
const reservedReason =
  '[stitchkit] CLI command "blocked" declares reserved option field(s): json';
// Separate entries exercise both field conflict classes and preserve the original diagnostic priority.
const shadowed = { ...blocked, input: z.object({ caller: z.string() }) };
async function run(argv, config = {}) {
  let out = '';
  let err = '';
  let code = -1;
  await createCli({
    name: 'catalog',
    version: '1',
    globalOptions,
    runtimeTools: [shadowed, healthy],
    argv,
    stdin: async () => {
      calls.stdin++;
      return null;
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
// Baseline 0.113.1 must fail here with the exact catalogue-wide startup throw.
assert.deepEqual(await run(['healthy', '--json']), {
  out: '{"text":"hello"}\n',
  err: '',
  code: 0,
});
assert.deepEqual(await run(['healthy', '--json'], { runtimeTools: [healthy, shadowed] }), {
  out: '{"text":"hello"}\n',
  err: '',
  code: 0,
});
for (const argv of [
  ['--help'],
  ['--help', 'blocked'],
  ['blocked', '--help'],
  ['blocked', '--help=true'],
  ['blocked', '--help=YES'],
]) {
  const help = await run(argv);
  assert.equal(help.code, 0);
  assert.equal(help.err, '');
  assert.ok(help.out.includes(`Unavailable: ${globalReason}`));
  if (argv[0] !== 'blocked') assert.ok(help.out.includes('[unavailable]'));
}
const before = { ...calls };
for (const [entry, reason] of [
  [shadowed, globalReason],
  [blocked, reservedReason],
]) {
  for (const argv of [
    ['blocked'],
    ['blocked', '--json'],
    ['blocked', '--dry-run', '--unknown', '--json=true'],
  ]) {
    const refused = await run(argv, { runtimeTools: [entry, healthy] });
    assert.equal(refused.code, 1);
    assert.equal(refused.out, '');
    assert.deepEqual(JSON.parse(refused.err), {
      error: 'CLI_COMMAND_UNAVAILABLE',
      retryable: false,
      details: { message: reason },
    });
  }
}
assert.deepEqual(calls, before);
const override = await run(['--json'], {
  defaultCommand: 'blocked',
  exitCodes: { CLI_COMMAND_UNAVAILABLE: 29 },
  errorHint: () => 'Repair the catalogue',
});
assert.equal(override.code, 29);
assert.equal(JSON.parse(override.err)._hint, 'Repair the catalogue');
await assert.rejects(
  run(['healthy'], {
    optionAliases: { blocked: { c: 'caller' } },
    passthrough: { blocked: 'caller' },
  }),
  /cannot alias passthrough field "caller"/,
);
const native = defineCliCommand({
  name: 'native',
  description: 'Authored operation',
  input: z.object({ caller: z.string() }),
  handler: () => undefined,
});
await assert.rejects(
  run(['healthy'], { commands: [native] }),
  /CLI command "native" declares field\(s\) shadowed/,
);
const invoker = await createCliInvoker(
  { name: 'catalog', globalOptions, runtimeTools: [blocked, healthy] },
  { caller: 'application' },
);
assert.deepEqual(await invoker.invoke('blocked', { caller: 'operation', json: false }), {
  ok: true,
  exitCode: 0,
  data: { caller: 'operation', json: false },
});
assert.equal((await invoker.invoke('healthy', {})).ok, true);
console.log('packed CLI runtime command isolation: ok');
